import {Fragment} from 'react';
import {Web3} from 'web3';
import {MetaModel} from "../pflow";
import {abi, contractDeclarationToJson, DeclarationResult, DEFAULT_CONTRACT} from "../pflow/contract";


// Call the contract method

interface ContractQueryProps {
    metaModel: MetaModel;
}


export default function ImportContract(props: ContractQueryProps) {

    async function onSubmit(evt: any) {
        evt.preventDefault();
        if (props.metaModel.ethAccount === 'null') {
            alert("Connect to Metamask first");
            return;
        }
        let address = evt.target[0].value;
        if (!address || address == "null") {
            address = DEFAULT_CONTRACT;
        }
        props.metaModel.setImportedContract(address);

        const connectedAccount = props.metaModel.ethAccount;
        const web3 = new Web3(window.ethereum);
        const contract = new web3.eth.Contract(abi, address);
        const result = await contract.methods.declaration().call({from: connectedAccount}) as unknown as DeclarationResult;
        const m = contractDeclarationToJson(result)
        console.log(m)
        return props.metaModel.loadJson(m).then(() => {
            return props.metaModel.commit({action: "importContract"})
        });
    }

    return <Fragment>
        <br/>
        <form onSubmit={onSubmit}>
            <input type="text" defaultValue={props.metaModel.getContract()} style={{width: "30em"}}/>
            <input type="submit" value="Import ETH Contract"/>
        </form>
        <br/>
    </Fragment>
}
