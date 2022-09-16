import EventEmitter from './EventEmitter';
import RPCError from './RPCError';
import { kl_log } from './../helpers/helpers';

class Web3Provider extends EventEmitter {
    connected = false;

    constructor( config ){
        super();
        
        this.keyless = config?.keylessInstance;
        kl_log('evt emitter');

        // this.emit('connected ');
        // return new Proxy( this, {
        //     get: async function( e ){
        //         kl_log( 'ok' );

        //         return Promise.resolve({ ok: true });
        //     }
        // });
    }

    async request( e ){
        if( !e.method ){
            return new RPCError('Method not described');
        } 
        if( !this.keyless.isConnected() ){
            return new RPCError('Provider not connected');
        }
        console.log( e.method );
        
        switch( e.method ){

            case 'eth_request':
            case 'eth_accounts':
            case 'eth_requestAccounts':
            case 'personal_listAccounts':
                if( !this.keyless._loggedin ){
                    return new RPCError('Please login in order to use keyless', 4200, 'Unauthorized');
                }

                const addrs = await this.keyless.kctrl.getAccounts();
                if( !addrs ){
                    throw new RPCError('Please connect to DAP');
                    // return Promise.reject( addr );
                }
                return Promise.resolve( [ addrs.address ] );

            break;

            case 'eth_getBalance':
                if( !this.keyless._loggedin ){
                    return new RPCError('Please login in order to use keyless', 4200, 'Unauthorized');
                }
                // const addr = this.keyless.kctrl.getAccounts();
                return this.keyless.kctrl.getWalletBalance( e.params[0] );
            break;

            case 'eth_sendTransaction':
                if( !this.keyless._loggedin ){
                    return new RPCError('Please login in order to use keyless', 4200, 'Unauthorized');
                }
                return this.keyless.kctrl.sendTransaction( e.params[0] );     
            break;

            case 'eth_getTransactionCount':
                if( !this.keyless._loggedin ){
                    return new RPCError('Please login in order to use keyless', 4200, 'Unauthorized');
                }
                return this.keyless.kctrl.web3.eth.getTransactionCount( e.params[0] );
            break;

            case 'eth_getBlockByNumber':
                if( !this.keyless._loggedin ){
                    return new RPCError('Please login in order to use keyless', 4200, 'Unauthorized');
                }
                return this.keyless.kctrl.web3.eth.getBlock( e.params[0], e.params[1] );
            break;

            case 'eth_gasPrice':
                return this.keyless.kctrl.web3.eth.getGasPrice();
            break;

            case 'eth_getTransactionReceipt':
                return {
                    transactionHash: '0xb903239f8543d04b5dc1ba6579132b143087c68db1b2168786408fcbce568238',
                }
            break;

            case 'eth_sign':
                if( !this.keyless._loggedin ){
                    return new RPCError('Please login in order to use keyless', 4200, 'Unauthorized');
                }
                return this.keyless.kctrl.signTransaction( e.params[0], e.params[1] );
            break;

            case 'eth_call':
                return await this.keyless.kctrl.ethCall( e.params[0], e.params[1] );
            break;

            case 'eth_estimateGas':
                return await this.keyless.kctrl.estimateGas( e.params[0] );
            break;

            default:
                // kl_log('default');
                console.log( e );

            break;
        }
    }
}

export default Web3Provider;