import { EventEmitter } from 'events';
export namespace driver {
    export class Client {
        constructor(url: string, options?: ConnectionOptions);
        open(): Promise<void>;//to confirm void in connection
        close(): Promise<void>;
        submit<Τ>(message: (process.Bytecode | string), bindings: Bindings): Promise<{ err: Error | null, results: ResultSet<Τ> }>;
    }

    export class Connection extends EventEmitter {
        constructor(url: string, options?: ConnectionOptions);
        open(): Promise<void>;//to confirm void in connection
        close(): Promise<void>;
        submit<Τ>(message: (process.Bytecode | string), bindings: Bindings): Promise<{ err: Error | null, results: ResultSet<Τ> }>;
    }

    export interface ResultSet<T> {
        items: Array<T>,
        attributes: Map<string, any>,
        length: number
    }

    export interface ConnectionOptions {
        ca?: string | string[] | Buffer | Buffer[],
        cert?: string | string[] | Buffer | Buffer[],
        pfx?: (String | Buffer),
        mimeType?: string,
        headers?: { [index: string]: string },
        pingEnabled?: boolean,
        pingInterval?: number,
        pongTimeout?: number,
        connectOnStartup?: boolean,
        rejectUnauthorized?: boolean,
        traversalSource?: string,
        reader?: structure.GraphSONReader,
        writer?: structure.GraphSONWriter,
        authenticator?: Authenticator
    }

    export interface Bindings {
        [key: string]: any;
    }
    export interface Authenticator {
        evaluateChallenge(challenge: string): any; //can be improved
    }
}

export namespace process {
    export type sourceName = 'with' | 'withBulk' | 'withPath' | 'withSack' | 'withSideEffect' | 'withStrategies' | 'withoutStrategies';
    export type stepName = 'E' | 'V' | 'addE' | 'addV' | 'inject' | 'io';
    export class Bytecode {
        addSource(name: sourceName, values: Array<object>): Bytecode;
        addStep(name: stepName, values: Array<object>): Bytecode;
        toString(): string;
    }
}

export namespace structure {
    export class GraphSONWriter {
        constructor(options?: SerializationOptions)
    }
    export class GraphSONReader {
        constructor(options?: SerializationOptions)
    }
    interface SerializationOptions {
        serializers?: { [index: string]: Serializer };
    }
    export interface Serializer {
        serialize(item: any): { typeKey: string, valueKey: any };
    }
}
