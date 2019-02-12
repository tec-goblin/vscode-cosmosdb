/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { EventEmitter } from 'events';
import * as gremlin from "gremlin";
import * as http from 'http';
import * as io from 'socket.io';
import * as vscode from 'vscode';
import { callWithTelemetryAndErrorHandling, IActionContext } from 'vscode-azureextensionui';
import { removeDuplicatesById } from "../utils/array";
import { rejectOnTimeout } from '../utils/timeout';
import { GraphConfiguration } from './GraphConfiguration';
import { GraphViewServerSocket } from "./GraphViewServerSocket";
import { IGremlinEndpoint } from "./gremlinEndpoints";

class GremlinParseError extends Error {
  constructor(err: Error) {
    super(err.message);
  }
}

class EdgeQueryError extends Error { }

function truncateWithEllipses(s: string, maxCharacters) {
  if (s && s.length > maxCharacters) {
    return `${s.slice(0, maxCharacters)}...`;
  }

  return s;
}

function truncateQuery(query: string) {
  return truncateWithEllipses(query, 100);
}

/**
 * @class GraphViewServer This is the server side of the graph explorer. It handles all communications
 * with Azure including gremlin queries. It communicates with the client code via an HTTP server and
 * sockets.
 */
export class GraphViewServer extends EventEmitter {
  private _server: io.Server;
  private _httpServer: http.Server;
  private _port: number | undefined;
  private _socket: GraphViewServerSocket;
  private _pageState: PageState;

  constructor(private _configuration: GraphConfiguration) {
    super();
    this._pageState = {
      query: undefined,
      results: undefined,
      errorMessage: undefined,
      view: 'graph',
      isQueryRunning: false,
      runningQueryId: 0
    };
  }

  public get configuration(): GraphConfiguration {
    return this._configuration;
  }

  public dispose() {
    if (this._socket) {
      this._socket.disconnect();
      this._socket = null;
    }
    if (this._httpServer) {
      this._httpServer.close();
      this._httpServer = null;
    }
    if (this._server) {
      this._server.close();
      this._server = null;
    }
  }

  public get port(): number {
    if (!this._port) {
      throw new Error("Server has not started");
    }

    return this._port;
  }

  public start(): Promise<void> {
    if (this._socket) {
      return Promise.resolve();
    }

    // how know resolve/reject?
    return new Promise((resolve, _reject) => {
      this._httpServer = http.createServer();
      this._httpServer.listen(
        0, // dynamnically pick an unused port
        () => {
          this._port = this._httpServer.address().port;
          console.log(`** GraphViewServer listening to port ${this._port} for ${this.configuration.gremlinEndpoint ? this.configuration.gremlinEndpoint.host : this.configuration.documentEndpoint}/${this._configuration.databaseName}/${this._configuration.graphName}`);
          resolve();
        });
      this._server = io(this._httpServer);

      this._server.on('connection', socket => {
        this.log(`Connected to client ${socket.id}`);
        this._socket = new GraphViewServerSocket(socket);
        this.setUpSocket();
      });

      this._server.on('error', _socket => {
        console.error("Error from server");
      });
    });
  }

  private get maxVertices(): number {
    return Math.max(1, vscode.workspace.getConfiguration().get<number>('cosmosDB.graph.maxVertices'));
  }

  private get maxEdges(): number {
    return Math.max(1, vscode.workspace.getConfiguration().get<number>('cosmosDB.graph.maxEdges'));
  }

  private getViewSettings(): GraphViewSettings {
    let viewSettings: GraphViewSettings = vscode.workspace.getConfiguration().get<GraphViewSettings>('cosmosDB.graph.viewSettings') || <GraphViewSettings>{};
    return viewSettings;
  }

  private async queryAndShowResults(queryId: number, gremlinQuery: string): Promise<void> {
    let results: GraphResults | undefined;
    const start = Date.now();

    try {
      // tslint:disable-next-line:no-var-self
      const thisServer: GraphViewServer = this;
      await callWithTelemetryAndErrorHandling("cosmosDB.gremlinQuery", async function (this: IActionContext): Promise<void> {
        // tslint:disable-next-line:no-var-self
        const actionContext: IActionContext = this;
        actionContext.rethrowError = true;
        actionContext.suppressErrorDisplay = true;

        thisServer._pageState = {
          query: gremlinQuery,
          results: undefined,
          errorMessage: undefined,
          isQueryRunning: true,
          runningQueryId: queryId,
          view: thisServer._pageState.view
        };

        actionContext.measurements.gremlinLength = gremlinQuery.length;
        let stepMatches = gremlinQuery.match(/[.]/g);
        actionContext.measurements.approxGremlinSteps = stepMatches ? stepMatches.length : 0;
        actionContext.properties.isDefaultQuery = gremlinQuery === "g.V()" ? "true" : "false";

        // Full query results - may contain vertices and/or edges and/or other things
        let fullResults = await thisServer.executeQuery(queryId, gremlinQuery);
        actionContext.measurements.mainQueryDuration = (Date.now() - start) / 1000;
        const edgesStart = Date.now();

        let vertices = thisServer.getVertices(fullResults);
        let { limitedVertices, countUniqueVertices } = thisServer.limitVertices(vertices);
        results = {
          fullResults,
          countUniqueVertices: countUniqueVertices,
          limitedVertices: limitedVertices,
          countUniqueEdges: 0, // Fill in later
          limitedEdges: []   // Fill in later
        };
        actionContext.measurements.countUniqueVertices = countUniqueVertices;
        actionContext.measurements.limitedVertices = limitedVertices.length;
        thisServer._pageState.results = results;

        if (results.limitedVertices.length) {
          try {
            // If it returned any vertices, we need to also query for edges
            let edges = await thisServer.queryEdges(queryId, results.limitedVertices);
            let { countUniqueEdges, limitedEdges } = thisServer.limitEdges(limitedVertices, edges);

            results.countUniqueEdges = countUniqueEdges;
            results.limitedEdges = limitedEdges;
            actionContext.measurements.countUniqueEdges = countUniqueEdges;
            actionContext.measurements.limitedEdges = limitedEdges.length;
            actionContext.measurements.edgesQueryDuration = (Date.now() - edgesStart) / 1000;
          } catch (edgesError) {
            throw new EdgeQueryError(`Error querying for edges: ${edgesError.message || edgesError}`);
          }
        }
      });
    } catch (error) {
      // If there's an error, send it to the client to display
      let message = this.removeErrorCallStack(error.message || error.toString());
      this._pageState.errorMessage = message;
      this._socket.emitToClient("showQueryError", queryId, message);
      return;
    } finally {
      this._pageState.isQueryRunning = false;
    }

    this._socket.emitToClient("showResults", queryId, results, this.getViewSettings());
  }

  // tslint:disable-next-line:no-any
  private getVertices(queryResults: any[]): GraphVertex[] {
    return queryResults.filter(n => n.type === "vertex" && typeof n.id === "string");
  }

  private limitVertices(vertices: GraphVertex[]): { countUniqueVertices: number, limitedVertices: GraphVertex[] } {
    vertices = removeDuplicatesById(vertices);
    let countUniqueVertices = vertices.length;

    let limitedVertices = vertices.slice(0, this.maxVertices);

    return { limitedVertices, countUniqueVertices };
  }

  private limitEdges(vertices: GraphVertex[], edges: GraphEdge[]): { countUniqueEdges: number, limitedEdges: GraphEdge[] } {
    edges = removeDuplicatesById(edges);

    // Remove edges that don't have both source and target in our vertex list
    let verticesById = new Map<string, GraphVertex>();
    vertices.forEach(n => verticesById.set(n.id, n));
    edges = edges.filter(e => {
      return verticesById.has(e.inV) && verticesById.has(e.outV);
    });

    // This should be the full set of edges applicable to these vertices
    let countUniqueEdges = edges.length;

    // Enforce max limit on edges
    let limitedEdges = edges.slice(0, this.maxEdges);
    return { limitedEdges, countUniqueEdges };
  }

  private async queryEdges(queryId: number, vertices: { id: string }[]): Promise<GraphEdge[]> {
    // Split into multiple queries because they fail if they're too large
    // Each of the form: g.V("id1", "id2", ...).outE().dedup()
    // Picks up the outgoing edges of all vertices, and removes duplicates
    let maxIdListLength = 5000; // Liberal buffer, queries seem to start failing around 14,000 characters

    let idLists: string[] = [];
    let currentIdList = "";

    for (let vertex of vertices) {
      let vertexId = `"${vertex.id}"`;
      if (currentIdList.length && currentIdList.length + vertexId.length > maxIdListLength) {
        // Start a new id list
        idLists.push(currentIdList);
        currentIdList = "";
      }
      currentIdList = (currentIdList ? (currentIdList + ",") : currentIdList) + vertexId;
    }
    if (currentIdList.length) {
      idLists.push(currentIdList);
    }

    // Build queries from each list of IDs
    // tslint:disable-next-line:no-any
    let promises: Promise<any[]>[] = [];
    for (let idList of idLists) {
      let query = `g.V(${idList}).outE().dedup()`;
      let promise = this.executeQuery(queryId, query);
      promises.push(promise);
    }

    let results = await Promise.all(promises);
    return Array.prototype.concat(...results);
  }

  private removeErrorCallStack(message: string): string {
    // Remove everything after the lines start looking like this:
    //    at Microsoft.Azure.Graphs.GremlinGroovy.GremlinGroovyTraversalScript.TranslateGroovyToCsharpInner()
    try {
      let match = message.match(/^\r?\n?\s*at \S+\(\)\s*$/m);
      if (match) {
        return message.slice(0, match.index);
      }
    } catch (error) {
      // Shouldn't happen, just being defensive
      console.error(error);
    }

    return message;
  }

  // tslint:disable-next-line:no-any
  private async executeQuery(queryId: number, gremlinQuery: string): Promise<any[]> {
    const maxRetries = 3; // original try + this many extra tries
    let iTry = 0;

    // tslint:disable-next-line:no-constant-condition
    while (true) {
      iTry++;

      try {
        if (iTry > 1) {
          this.log(`Retry #${iTry - 1} for query ${queryId}: ${truncateQuery(gremlinQuery)}`);
        }
        return await this._executeQueryCore(queryId, gremlinQuery);
      } catch (err) {
        if (this.isErrorRetryable(err)) {
          if (iTry >= maxRetries) {
            this.log(`Max retries reached for query ${queryId}: ${truncateQuery(gremlinQuery)}`);
          } else {
            continue;
          }
        } else if (this.isParseError(err)) {
          err = new GremlinParseError(err);
        }

        throw err;
      }
    }
  }

  // tslint:disable-next-line:no-any
  private async _executeQueryCore(queryId: number, gremlinQuery: string): Promise<any[]> {
    if (this.configuration.gremlinEndpoint) {
      return await this._executeQueryCoreForEndpoint(queryId, gremlinQuery, this.configuration.gremlinEndpoint);
    } else {
      // We haven't figured out yet which endpoint actually works (if any - network could be down, etc.), so try them all
      let firstValidError: {} = null;
      for (let endpoint of this.configuration.possibleGremlinEndpoints) {
        try {
          const result = await this._executeQueryCoreForEndpoint(queryId, gremlinQuery, endpoint);
          this.configuration.gremlinEndpoint = endpoint;
          return Promise.resolve(result);
        } catch (err) {
          if (err.code === "ENOTFOUND") {
            // Not a valid endpoint
          } else {
            firstValidError = firstValidError || err;
          }
        }
      }

      // If here, no endpoint succeeded
      if (firstValidError) {
        throw firstValidError;
      } else {
        throw new Error(`Could not find a valid gremlin endpoint for ${this.configuration.graphName}.\r\n\r\nTried ${this.configuration.possibleGremlinEndpoints.map(e => e.host).join(", ")}`);
      }
    }
  }

  // tslint:disable-next-line:no-any
  private async _executeQueryCoreForEndpoint(queryId: number, gremlinQuery: string, endpoint: IGremlinEndpoint): Promise<any[]> {
    this.log(`Executing query #${queryId} (${endpoint.host}:${endpoint.port}): ${truncateQuery(gremlinQuery)}`);
    let newHostURI = `wss://${endpoint.host}:${endpoint.port}`;
    const username = `/dbs/${this._configuration.databaseName}/colls/${this._configuration.graphName}`;
    const password = this._configuration.key;
    const authenticator = new gremlin.driver.auth.PlainTextSaslAuthenticator(username, password);
    const client = new gremlin.driver.Client(
      newHostURI,
      {
        "authenticator": authenticator
      });

    let clientSubmitTimeout = 5 * 1000;
    return await rejectOnTimeout(clientSubmitTimeout, async () => {
      try {
        const result = await client.submit(gremlinQuery);
        this.log("Results from gremlin", result.results.items);
        return result.results.items; //this is needed only for version 3.4 (for 3.3.4 return result directly)
      }
      catch (err) {
        this.log("Error from gremlin server: ", err.message || err.toString());
        throw err;
      }
    }
    );
  }

  private isParseError(err: { message?: string }): boolean {
    if (err.message) {
      return !!err.message.match(/ScriptEvaluationError/);
    }
    else {
      return false;
    }
  }

  private isErrorRetryable(err: { message?: string }) {
    // Unfortunately the gremlin server aggregates errors so we can't simply query for status
    if (err.message) {
      if (err.message.match(/Status *: *429/) || err.message.match(/RequestRateTooLarge/)) {
        // Query exceeds allocated RUs, we're supposed to try again
        return true;
      }
    }

    return false;
  }

  private handleGetPageState(): void {
    this.log('getPageState');

    if (this._pageState.query) {
      this._socket.emitToClient('setPageState', this._pageState, this.getViewSettings());
    }
  }

  private handleSetQuery(query: string) {
    this.log('setQuery');
    this._pageState.query = query;
  }

  private handleSetView(view: 'graph' | 'json') {
    this.log('setView');
    this._pageState.view = view;
  }

  private handleQueryMessage(queryId: number, gremlinQuery: string) {
    this.log(`Query requested: queryId=${queryId}, gremlin="${gremlinQuery}"`);

    //tslint:disable-next-line:no-floating-promises
    this.queryAndShowResults(queryId, gremlinQuery);
  }

  private handleGetTitleMessage() {
    this.log(`getTitle`);
    this._socket.emitToClient('setTitle', `${this._configuration.databaseName} / ${this._configuration.graphName}`);
  }

  private setUpSocket() {
    // tslint:disable-next-line:no-any
    this._socket.onClientMessage('log', (...args: any[]) => {
      this.log('from client: ', ...args);
    });

    // Handle QueryTitle event from client
    this._socket.onClientMessage('getTitle', () => this.handleGetTitleMessage());

    // Handle query event from client
    this._socket.onClientMessage('query', (queryId: number, gremlinQuery: string) => this.handleQueryMessage(queryId, gremlinQuery));

    // Handle state event from client
    this._socket.onClientMessage('getPageState', () => this.handleGetPageState());

    // Handle setQuery event from client
    this._socket.onClientMessage('setQuery', (query: string) => this.handleSetQuery(query));

    // Handle setView event from client
    this._socket.onClientMessage('setView', (view: 'graph' | 'json') => this.handleSetView(view));
  }

  // tslint:disable-next-line:no-any
  private log(_message, ..._args: any[]) {
    console.log(_message, ..._args);
  }
}
