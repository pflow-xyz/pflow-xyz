/* Autogenerated file. Do not edit manually. */
/* tslint:disable */
/* eslint-disable */

import { Contract, Interface, type ContractRunner } from "ethers";
import type {
  ModelInterface,
  ModelInterfaceInterface,
} from "../ModelInterface";

const _abi = [
  {
    inputs: [],
    name: "context",
    outputs: [
      {
        components: [
          {
            internalType: "uint256[10]",
            name: "latestBlocks",
            type: "uint256[10]",
          },
          {
            internalType: "uint256",
            name: "sequence",
            type: "uint256",
          },
          {
            internalType: "int256[]",
            name: "state",
            type: "int256[]",
          },
          {
            components: [
              {
                internalType: "string",
                name: "label",
                type: "string",
              },
              {
                internalType: "uint8",
                name: "offset",
                type: "uint8",
              },
              {
                components: [
                  {
                    internalType: "uint8",
                    name: "x",
                    type: "uint8",
                  },
                  {
                    internalType: "uint8",
                    name: "y",
                    type: "uint8",
                  },
                ],
                internalType: "struct Model.Position",
                name: "position",
                type: "tuple",
              },
              {
                internalType: "uint256",
                name: "initial",
                type: "uint256",
              },
              {
                internalType: "uint256",
                name: "capacity",
                type: "uint256",
              },
            ],
            internalType: "struct Model.Place[]",
            name: "places",
            type: "tuple[]",
          },
          {
            components: [
              {
                internalType: "string",
                name: "label",
                type: "string",
              },
              {
                internalType: "uint8",
                name: "offset",
                type: "uint8",
              },
              {
                components: [
                  {
                    internalType: "uint8",
                    name: "x",
                    type: "uint8",
                  },
                  {
                    internalType: "uint8",
                    name: "y",
                    type: "uint8",
                  },
                ],
                internalType: "struct Model.Position",
                name: "position",
                type: "tuple",
              },
              {
                internalType: "uint8",
                name: "role",
                type: "uint8",
              },
              {
                internalType: "int256[]",
                name: "delta",
                type: "int256[]",
              },
              {
                internalType: "int256[]",
                name: "guard",
                type: "int256[]",
              },
            ],
            internalType: "struct Model.Transition[]",
            name: "transitions",
            type: "tuple[]",
          },
        ],
        internalType: "struct Model.Head",
        name: "",
        type: "tuple",
      },
    ],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      {
        internalType: "uint8",
        name: "action",
        type: "uint8",
      },
      {
        internalType: "uint256",
        name: "scalar",
        type: "uint256",
      },
    ],
    name: "signal",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      {
        internalType: "uint8[]",
        name: "actions",
        type: "uint8[]",
      },
      {
        internalType: "uint256[]",
        name: "scalars",
        type: "uint256[]",
      },
    ],
    name: "signalMany",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

export class ModelInterface__factory {
  static readonly abi = _abi;
  static createInterface(): ModelInterfaceInterface {
    return new Interface(_abi) as ModelInterfaceInterface;
  }
  static connect(
    address: string,
    runner?: ContractRunner | null
  ): ModelInterface {
    return new Contract(address, _abi, runner) as unknown as ModelInterface;
  }
}
