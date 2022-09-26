import './scss/index.scss';
import KeylessWeb3 from './classes/KeylessWeb3';
import config from './config/config';

const safleBlockchainController = require('@getsafle/blockchain-controller');


const getNetworks = async () => {
    const networks = await fetch( config.networks ).then(e=>e.json());
    const allowedIds = [ 1, 3, 42, 4, 420, 137, 80001 ];
    return Object.values( networks ).reduce( (acc, e) => acc.concat( e ), [] ).filter( e=> allowedIds.indexOf( e.chainId ) != -1 );

    return networks;

}


export {
    KeylessWeb3,
    getNetworks
}