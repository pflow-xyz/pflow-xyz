import {Dsl, Model, ModelType, newModel, TxNode} from "../protocol";

interface Position {
    x: number;
    y: number;
    z: number;
}

interface Control {
    up: TxNode;
    down: TxNode;
    left: TxNode;
    right: TxNode;
    select: TxNode;
    start: TxNode;
    b: TxNode;
    a: TxNode;
}

function pos(x: number, y: number): Position {
    return {x: x * 80, y: y * 80 + 40, z: 0}
}

export function gamepadModel(): Model {
    return newModel({
        type: ModelType.petriNet,
        declaration: ({fn, cell, role}: Dsl) => {
            gamepad({fn, cell, role});
        },
    });
}

export function konamiCodeModel(): Model {
    return newModel({
        type: ModelType.petriNet,
        declaration: konamiCode,
    });
}

export function gamepad({fn, cell, role}: Dsl): Control {
    let btn = role("button")

    return {
        up: fn("up", btn, pos(2, 1)),
        down: fn("down", btn, pos(2, 3)),
        left: fn("left", btn, pos(1, 2)),
        right: fn("right", btn, pos(3, 2)),
        select: fn("select", btn, pos(4, 2)),
        start: fn("start", btn, pos(5, 2)),
        b: fn("b", btn, pos(6, 2)),
        a: fn("a", btn, pos(7, 2)),
    }
}

function konamiCode({fn, cell, role}: Dsl): void {
    let control: Control = gamepad({fn, cell, role});

    let up2: any = cell("up.up", 2, 2, pos(2, 2));
    up2.tx(1, control.up);
    up2.guard(1, control.down);

    let down2: any = cell("down.down", 2, 2, pos(1, 3));
    down2.tx(1, control.down);
    down2.guard(1, control.left);

    let left2: any = cell("two.lefts", 2, 2, pos(1, 1));
    left2.tx(1, control.left);

    let thenRight: any = cell("then.right", 0, 1, pos(3, 3));
    thenRight.tx(1, control.right);
    control.left.tx(1, thenRight);

    let right2: any = cell("two.rights", 0, 0, pos(3, 1));
    right2.tx(2, control.b);
    control.right.tx(1, right2);

    let thenA: any = cell("then.A", 0, 1, pos(6, 1));
    thenA.tx(1, control.a);
    control.b.tx(1, thenA);

    let thenSelect: any = cell("then.Select", 0, 1, pos(4, 3));
    thenSelect.tx(1, control.select);
    control.a.tx(1, thenSelect);

    let thenStart: any = cell("then.Start", 0, 1, pos(5, 3));
    thenStart.tx(1, control.start);
    control.select.tx(1, thenStart);
}


// function combo({fn: Fn, cell: Cell, role: Role}: Dsl): DeclarationFunction {
//     let offsetX: number = 4;
//     let offsetY: number = 4;
//     let control: Control = gamepad({fn, cell, role});
//
//     function comboFactory(ngram: string[]): any {
//         let cur: number = 0;
//         let origin: any = cell("origin", 1, 1, pos(4, 1));
//         origin.tx(1, control[ngram[cur]]);
//
//         while (cur < ngram.length-1) {
//             let first: any = control[ngram[cur]];
//             let next: any = control[ngram[cur+1]];
//             let andThen: any = cell(first.transition.label+".then."+next.transition.label, 0, 1, pos(offsetX+cur, offsetY));
//             first.tx(1, andThen);
//             andThen.tx(1, next);
//             cur = cur+1;
//         }
//
//         let noop: any = cell("noop", 1, 1, pos(5, 1));
//         let controls: string[] = Object.keys(control);
//         for (let i in controls) {
//             let cmd: string = controls[i];
//             if (ngram.indexOf(cmd) < 0) {
//                 if (control[cmd] && control[cmd].transition) {
//                     noop.guard(1, control[cmd]);
//                 }
//             }
//         }
//     }
//     return comboFactory;
// }
//
// let model = {
//     buttons: domodel("gamepad", gamepad).def.transitions,
//     comboMoves: new Map([
//         [ "konami.code", konamiCode], // coded model
//         [ "upper.cut", ["down", "up", "a"]], // sequence models loaded with comboFactory
//         [ "sweep.kick", ["up", "down", "b"]],
//         [ "upper.kick", ["up", "b"]],
//         [ "upper.block", ["left", "a"]],
//         [ "upper.punch", ["up", "a"]],
//         [ "lower.punch", ["down", "a"]],
//         [ "lower.kick", ["down", "b"]],
//         [ "lower.block", ["left", "b"]],
//         [ "combo.breaker", ["a", "b"]],
//     ])
// }