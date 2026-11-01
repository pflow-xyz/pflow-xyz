/* tslint:disable */
/* eslint-disable */

/**
 * A loaded theory being checked step by step.
 */
export class Session {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Check every remaining part. Returns the outline.
     */
    check_all(): string;
    done(): boolean;
    /**
     * Errors so far, as a JSON list of {line, msg}.
     */
    errors(): string;
    len(): number;
    /**
     * Replace the theory with `source` and start checking from the top.
     * Returns the outline.
     */
    load(source: string): string;
    /**
     * Load (parse) a theory. Nothing is checked yet.
     */
    constructor(source: string);
    /**
     * Parts (without diagrams), errors, rules and status counts so far.
     */
    outline(): string;
    /**
     * Part `index` with its diagrams and layout ("null" if out of range).
     */
    part(index: number): string;
    /**
     * Index of the next part `step` will check.
     */
    position(): number;
    /**
     * Start checking again from the first part.
     */
    reset(): void;
    /**
     * A named rule's two sides as diagrams ("null" if there is none).
     */
    rule(name: string): string;
    /**
     * Check the next part and return it with its diagrams, layout and the
     * proof state after it; "null" once every part has been checked.
     */
    step(): string;
}

/**
 * Parse and check a whole theory in one call; returns the theory JSON with
 * every diagram laid out.
 */
export function check(source: string): string;

/**
 * The upstream Chyp commit this port follows.
 */
export function upstream_commit(): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_session_free: (a: number, b: number) => void;
    readonly check: (a: number, b: number, c: number) => void;
    readonly session_check_all: (a: number, b: number) => void;
    readonly session_done: (a: number) => number;
    readonly session_errors: (a: number, b: number) => void;
    readonly session_len: (a: number) => number;
    readonly session_load: (a: number, b: number, c: number, d: number) => void;
    readonly session_new: (a: number, b: number) => number;
    readonly session_outline: (a: number, b: number) => void;
    readonly session_part: (a: number, b: number, c: number) => void;
    readonly session_position: (a: number) => number;
    readonly session_reset: (a: number) => void;
    readonly session_rule: (a: number, b: number, c: number, d: number) => void;
    readonly session_step: (a: number, b: number) => void;
    readonly upstream_commit: (a: number) => void;
    readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
    readonly __wbindgen_export: (a: number, b: number) => number;
    readonly __wbindgen_export2: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_export3: (a: number, b: number, c: number) => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
