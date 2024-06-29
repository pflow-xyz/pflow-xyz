import {Model, Result, Vector} from "./model";

export type Handler<TEvent extends Event> = {
    (s: Stream<TEvent>, evt: TEvent): void;
}

export type Dispatcher<TEvent extends Event> = {
    getHandler: (action: string) => Handler<TEvent>;
    on: (action: string, handler: Handler<TEvent>) => void;
    off: (action: string) => void;
    onFail: (handler: Handler<TEvent>) => void;
    fail: Handler<TEvent>;
}

type StreamArgs<TEvent extends Event> = {
    model: Model;
}

type Event = {
    action: string;
    multiple: number;
}

type EventLog<TEvent> = {
    seq: number;
    event: TEvent;
    ts: number; // micro
}

export class Stream<TEvent extends Event> {
    readonly dispatcher: Dispatcher<TEvent>;
    // @ts-ignore
    public state: Vector;
    public model: Model;
    public history: Array<EventLog<TEvent>> = [];
    private seq = 0;

    constructor({model}: StreamArgs<TEvent>) {
        this.seq = 0;
        this.history = [];
        this.model = model;
        this.dispatcher = this.newDispatcher();
        this.dispatch = this.dispatch.bind(this);
    }

    dispatch(evt: TEvent): Result {
        const state: Vector = this.state || this.model.initialVector();

        return this.model.fire(state, evt.action, evt.multiple,
            ({out, role}) => {
                this.state = out;
                this.history.push({seq: this.seq++, event: evt, ts: Date.now()});
                const callback = this.dispatcher.getHandler(evt.action);
                if (callback) {
                    callback(this, {...evt, role});
                }
            },
            ({role}) => {
                this.dispatcher.fail(this, {...evt, role});
            });
    }

    restart() {
        this.seq = 0;
        this.history = [];
        this.state = this.model.initialVector();
    }

    private newDispatcher(): Dispatcher<TEvent> {
        const eventHandlers: Map<string, Handler<TEvent>> = new Map<string, Handler<TEvent>>();
        return {
            // @ts-ignore
            getHandler: (action: string) => eventHandlers.get(action),
            on: (action: string, handler: Handler<TEvent>) => eventHandlers.set(action, handler),
            off: (action: string) => eventHandlers.delete(action),
            onFail: (handler: Handler<TEvent>) => eventHandlers.set("__onFail__", handler),
            fail: (s: Stream<TEvent>, evt: TEvent) => {
                const callback = eventHandlers.get("__onFail__");
                if (callback) {
                    callback(s, evt);
                }
            }
        };
    }

}