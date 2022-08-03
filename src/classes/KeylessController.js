import Web3 from 'web3';
import blockchainInfo from './../helpers/blockchains';
import { middleEllipsis, formatPrice, formatXDecimals } from './../helpers/helpers';
import * as safleHelpers from './../helpers/safleHelpers';
import Storage from './../classes/Storage';
import Vault from '@getsafle/safle-vault';
import asset_controller  from '@getsafle/asset-controller';
const safleIdentity = require('@getsafle/safle-identity-wallet').SafleID;
import { kl_log } from './../helpers/helpers';

const { FeeMarketEIP1559Transaction, Transaction } = require('@ethereumjs/tx');
const Common = require('@ethereumjs/common').default;
const { Hardfork } = require('@ethereumjs/common');
const { bufferToHex }=require('ethereumjs-util');


class KeylessController {
    vault = false;
    wallets = [];
    activeChain;
    activeWallet;
    flowState = 0;
    activeTransaction = null;
    activeSignRequest = null;
    transactionHashes = [];
    tokenData = {};
    _isMobileVault = false;

    constructor( keylessInstance, chains = [] ){
        this.keylessInstance = keylessInstance;
        if( chains[0].hasOwnProperty('rpcURL') ){
            this._setBlockchainRPC( chains );
        }
        const state = Storage.getState();
        const { chainId: sessionChainId = '', activeWallet: sessionActiveWallet = false } = state;
        if (sessionChainId) {
            this.activeChain = this.keylessInstance.allowedChains.find( e => e.chainId == sessionChainId );
            kl_log('CHAINID on signin', this.activeChain );
            this.activeWallet = sessionActiveWallet;
            
            this.loadVault().then( () => {
                this.keylessInstance._loggedin = true;
                this._loginSuccess( false );
            });
        }
        const nodeURI = this.getNodeURI(this.activeChain?.chainId);
        
        this.web3 = new Web3( new Web3.providers.HttpProvider( nodeURI ));

        this.loadTokenData();
    }

    async loadVault(){
        const state = Storage.getState();
        if( state.hasOwnProperty('isMobile') ){
            this._isMobileVault = state.isMobile;
        }

        if( state.vault && state.decriptionKey != null ){
            this.vault = new Vault( state.vault );
            //todo - move this to helpers
            const decKey = state.decriptionKey.reduce( ( acc, el, idx ) => { acc[idx]=el;return acc;}, {} );
            try {
                const acc = await this.vault.getAccounts( decKey );
                kl_log( acc );

                this.wallets = acc.response.map( e => { return { address: e.address }} ) || [];
                kl_log( this.wallets );
            } catch( e ){
                this.wallets = [];
                kl_log( e );
            }

            if( this.wallets.length == 0 ){
                //todo - handle empty vault case
                throw new Error('No wallets found in the current vault');
            }
            this.activeWallet = state?.activeWallet || 0;
        } else {
            console.error('user is not logged in or vault empty.');
        }
    }

    async login( user, pass ){
        if( !window.grecaptcha ){
            kl_log('Recaptcha not available.');
        }
        this._setLoading( true );
        kl_log('login with user '+user+', pass '+pass );

        this._isMobileVault = await this._getIsVaultMobile( user );
        kl_log( this._isMobileVault );

        await grecaptcha.execute();
        let captchaToken = grecaptcha.getResponse();
        // kl_log( token );
        const resp = await safleHelpers.login( user, pass, captchaToken );
        const safleToken = resp.data.token;
        

        //pull vault from cloud
        await grecaptcha.execute();
        captchaToken = grecaptcha.getResponse();
        const authToken = await safleHelpers.getCloudToken( user, pass, captchaToken );

        let passwordDerivedKey = await safleHelpers.generatePDKey({ safleID: user, password: pass });
        const pdkeyHash = await safleHelpers.createPDKeyHash({ passwordDerivedKey });
        const vault = await safleHelpers.retrieveVaultFromCloud( pdkeyHash, authToken );
        const encKey = await safleHelpers.retrieveEncryptionKey( pdkeyHash, authToken );
        // kl_log( encKey );

        Storage.saveState( { 
            vault, 
            decriptionKey: safleHelpers.decryptEncryptionKey( user, pass, Object.values( encKey ) ),
            safleID: user,
            isMobile: this._isMobileVault
        });
        this.keylessInstance._loggedin = true;

        await this.loadVault();

        this._setLoading( false );
        
        this.flowState = 1;
        
        this.keylessInstance._showUI('switchChain');
        // return true;
    }
    logout(){
        // Storage.saveState({vault: null})
        this.keylessInstance._loggedin = false;
        Storage.clear();
    }

    _loginSuccess( openDashboard = true ){
        const addreses = this.getAccounts();
        this.keylessInstance._connected = true;
        this.keylessInstance.provider.emit('login successful', addreses );
        if( openDashboard ){
            this.keylessInstance.openDashboard();
        }
    }

    // re-build web3 instance for the current blockchain
    switchNetwork( chainId){
        kl_log( 'rebuild web3 object for EVM chainId ', chainId );
        this.web3 = this.generateWeb3Object(chainId);
        Storage.saveState({ chainId });
    }

    generateWeb3Object(chainId) {
        const nodeURI = this.getNodeURI(chainId);
        return new Web3( new Web3.providers.HttpProvider( nodeURI ));
    }


    //sign transaction func
    signTransaction( address, data ){
        this.activeSignRequest = {
            data: data,
            address: address
        };
        this.activeSignRequest.promise = new Promise( ( res, rej ) => {
            if( this._isMobileVault ){
                this.keylessInstance._showUI('scanQR');
            } else {
                this.keylessInstance._showUI('sign');
            }
            this.activeSignRequest.resolve = res;
            this.activeSignRequest.reject = rej;
        });
        return this.activeSignRequest.promise;
    }

    getSignRequestData(){
        if( this.activeSignRequest ){
            return this.web3.utils.hexToUtf8( this.activeSignRequest.data );
        } else {
            throw new Error('No active signed request');
            return '';
        }
    }

    // send transaction func
    sendTransaction( config ){
        const trans = this._sanitizeTransaction( config );
        if( !trans ){
            return;
        }
        this.activeTransaction = {
            data: trans,
        };
        this.activeTransaction.promise = new Promise( ( res, rej ) => {
            if( this._isMobileVault ){
                this.keylessInstance._showUI('scanQR');
            } else {
                this.keylessInstance._showUI('send');
            }
            
            this.activeTransaction.resolve = res;
            this.activeTransaction.reject = rej;
        });
        return this.activeTransaction.promise;
    }

    setGasForTransaction( gasLimit, maxFeePerGas, maxPriorityFee ){
        if( this.activeTransaction ){
            this.activeTransaction.data.gasLimit = gasLimit;
            this.activeTransaction.data.maxFeePerGas = maxFeePerGas;
            this.activeTransaction.data.maxPriorityFeePerGas = maxPriorityFee;
        }
    }

    getActiveTransaction(){
        if( this.activeTransaction ){
            return this.activeTransaction;
        }
        return null;
    }
    clearActiveTransaction( reject = false ){
        if( reject && !this.activeTransaction.promise.fulfilled ){
            this.activeTransaction.reject({
                message: 'User rejected the transaction',
                code: 4200,
                method: 'User rejected'
            })
        }
        this.activeTransaction = null;
    }


    getAccounts( all = false ){
        return all? this.wallets : this.activeWallet? this.wallets[ this.activeWallet ] : this.wallets[ 0 ];
    }

    async getTokens(){
        const address = this.getAccounts().address;
        const chain = blockchainInfo[ this.keylessInstance.getCurrentChain()?.chainId ].chain_name;
        kl_log( 'gettokens', address, chain, this.getNodeURI() );
        const assets = new asset_controller.AssetController({ chain , rpcURL: this.getNodeURI() });
        const erc20Balance = await assets.detectTokens({ tokenType: 'erc20', userAddress: address });

        return erc20Balance;
    }

    // option transformers
    getChainsOptions( options ){
        return options.map( chain => {
            // kl_log( chain );
            return {
                ...chain,
                label: blockchainInfo.hasOwnProperty( chain.chainId )? blockchainInfo[ chain.chainId ].name : chain.name+' - '+chain.network,
                icon: ''
            }
        })
    }

    getNodeURI( chainID = false ){
        const chainId = chainID? chainID : this.keylessInstance.getCurrentChain().chainId;
        return blockchainInfo.hasOwnProperty( chainId )? blockchainInfo[ chainId ].rpcURL : '';
    }

    async getAddressesOptions( options, web3Obj){
        const balances = await this._getWalletBalances( options.map( e => e.address ), web3Obj );
        // kl_log( balances );

        return options.map( wallet => {
            return {
            ...wallet,
            label: middleEllipsis( wallet.address, 10 ),
            longLabel: wallet.address,
            balance: balances[ wallet.address ],
        } })
    }

    async _getWalletBalances( addreses, web3Obj ){
        // todo - get wallet native token balances
        const balances = {};
        for( var i in addreses ){
            balances[ addreses[i] ] = await this.getWalletBalance( addreses[i].toLowerCase(), true, false, web3Obj );
        }
        // kl_log('KeylessController._getWalletBalances', balances );
        return balances;
    }

    async getWalletBalance( address, returnETH = false, digits=false, web3Obj = this.web3 ){
        const bal = await web3Obj.eth.getBalance( address, 'latest' );
        if( returnETH ){
            const balance = web3Obj.utils.fromWei( bal.toString(), 'ether' );
            return digits ? parseFloat(balance).toFixed(digits) : balance;
        }
        return bal;
    }

    async getBalanceInUSD( balance ){
        try {
            const nativeTokenName = await this.getCurrentNativeToken();

            if (!process.env.SAFLE_TOKEN_API) {
                throw new Error('Please check the environment variables...');
            }
            
           let res = await fetch(`${process.env.SAFLE_TOKEN_API}/latest-price?coin=${nativeTokenName}`).then(e=>e.json());
            const rate = res.data?.data[ nativeTokenName.toUpperCase() ]?.quote?.USD?.price;
            
            const priceUSD = isNaN( rate )? 0 : rate;
            kl_log( 'KeylessController.getBalanceInUSD',  balance, priceUSD );
            return formatXDecimals( parseFloat( balance ) * parseFloat( priceUSD ), 3 );
        } catch( e ){
            kl_log('Error fetching usd balance', e.message );
            return 0;
        }
    }

    async getCurrentNativeToken(){
        let activeChain = await this.keylessInstance.getCurrentChain();
        kl_log('ACTIVE CHAIN', activeChain );
        return activeChain.chain.symbol.toLowerCase();
    }
    

    getFeeInEth( number ){
        return this.web3.utils.fromWei( this.web3.utils.toWei( number.toString(), 'gwei').toString(), 'ether');
    }

    async estimateGas( { to, from, value } ){
        try {
            const res = await this.web3.eth.estimateGas( { to, from, value } );
            return res;
        } catch ( e ){
            return 21000;
        }
    }

    async estimateFees(){
        let activeChain = await this.keylessInstance.getCurrentChain();
        const eth_node = blockchainInfo[ activeChain.chainId ].rpcURL;

        try {    
            let response;
            if( eth_node.indexOf('polygon-mumbai') != -1 ){
                return {
                    estimatedBaseFee: 16,
                    high: {
                        maxWaitTimeEstimate: 10*1000,
                        minWaitTimeEstimate: 5*1000,
                        suggestedMaxFeePerGas: 250,
                        suggestedMaxPriorityFeePerGas: 250
                        
                    },
                    medium: {
                        maxWaitTimeEstimate: 30*1000,
                        minWaitTimeEstimate: 10*1000,
                        suggestedMaxFeePerGas: 180,
                        suggestedMaxPriorityFeePerGas: 180
                    }, 
                    low: {
                        maxWaitTimeEstimate: 60*1000,
                        minWaitTimeEstimate: 30*1000,
                        suggestedMaxFeePerGas: 140,
                        suggestedMaxPriorityFeePerGas: 140
                    }
                };
            } 

            if( eth_node.indexOf('polygon') != -1 ){
                //fetch gas for polygon
                const url = `https://gasstation-mainnet.matic.network/`;
                let resp = await this.getRequest( { url} );

                if( !resp ){
                    resp = {
                        fastest: 0, 
                        standard: 0, 
                        fast: 0                       
                    }
                }

                // kl_log( 'FEES', resp );

                response = {
                    estimatedBaseFee: '0',
                    high: {
                        maxWaitTimeEstimate: 10*1000,
                        minWaitTimeEstimate: 5*1000,
                        suggestedMaxFeePerGas: resp.fastest,
                        suggestedMaxPriorityFeePerGas: resp.fastest
                        
                    },
                    medium: {
                        maxWaitTimeEstimate: 30*1000,
                        minWaitTimeEstimate: 10*1000,
                        suggestedMaxFeePerGas: resp.fast,
                        suggestedMaxPriorityFeePerGas: resp.fast
                    }, 
                    low: {
                        maxWaitTimeEstimate: 60*1000,
                        minWaitTimeEstimate: 30*1000,
                        suggestedMaxFeePerGas: resp.standard,
                        suggestedMaxPriorityFeePerGas: resp.standard
                    }
                };

            } else {
                const chainId = activeChain.chainId;
                const url = `https://gas-api.metaswap.codefi.network/networks/${chainId}/suggestedGasFees`;
                response = await this.getRequest({ url });
            }
            console.log('FEES', response );
            return response;
        } catch( e ){
            kl_log('error', e );
            return null;
        }
    }

    async checkPin( pin ){
        try {
            const v = await this.vault.validatePin( parseInt( pin ) );
            // kl_log( v );
            return v.response;
        } catch( e ){
            // kl_log( e.message );
            return false;
        }
    }

    async _createAndSendTransaction( pin ) {
        const chain = this.keylessInstance.getCurrentChain();
        const trans = this.activeTransaction;
        if( !trans ){
            kl_log('transaction does not exist');
            return;
        }
        kl_log( trans );
        
        const rawTx = await this._createRawTransaction( trans );
        rawTx.from = rawTx.from.substr(0, 2)+ rawTx.from.substr(-40).toLowerCase();
        rawTx.to = rawTx.to.substr(0, 2)+ rawTx.to.substr(-40).toLowerCase();

        console.log("TRANS", trans );
        // return false;
        
        const state = Storage.getState();
        const decKey = state.decriptionKey.reduce( ( acc, el, idx ) => { acc[idx]=el;return acc;}, {} );
        this.vault.restoreKeyringState( state.vault, pin, decKey );

        const chainName = chain.chain.rpcURL.indexOf('polygon') != -1? 'polygon' : 'ethereum';
        // this.vault.changeNetwork( chainName );

        kl_log('RAW', rawTx );

        try {
            const signedTx = await this._signTransaction( rawTx, pin, chain.chainId );
            kl_log( 'signed', signedTx );

            const tx = this.web3.eth.sendSignedTransaction( signedTx );
        
            tx.once('transactionHash', ( hash ) => {
                kl_log( 'txn hash', hash );
                this.transactionHashes.push( hash );
                this.keylessInstance._showUI('txnSuccess');

            });
            const sub = tx.once('receipt', ( err, txnReceipt ) => {
                kl_log('receipt', receipt );
                if( txnReceipt.status == 1 ){
                    this.keylessInstance.provider.emit('transactionSuccess', { receipt: txnReceipt } );
                } else {
                    this.keylessInstance._showUI('txnFailed'); 
                    this.keylessInstance.provider.emit('transactionFailed', { receipt: txnReceipt } );
                }
            });
            tx.on('confirmation', ( confNr, receipt ) => {
                kl_log('confirmations', confNr );
                // kl_log('receipt', receipt );
                tx.off('receipt');
                tx.off('confirmation');
                this.keylessInstance.provider.emit('transactionComplete', { receipt: txnReceipt } );
            })/*.once('error', ( e, receipt ) => {
                // kl_log('errror', e );
                kl_log('txn', receipt );
                this.keylessInstance.provider.emit('transactionFailed', { receipt } );

                this.keylessInstance._showUI('txnFailed');                 
            })*/
            tx.then( receipt => {
                kl_log('receipt', receipt );
               // this.keyless._showUI('txnSuccess');
               this.keylessInstance.provider.emit('transactionSuccess', { receipt } );
            }).catch( err => { 
                kl_log('uncaught', err )
                Storage.saveState( { lastError: err.message } );
                this.keylessInstance._showUI('txnFailed');
                this.keylessInstance.provider.emit('transactionFailed', { receipt: err.message });
            });
        } catch ( e ){
            Storage.saveState( { lastError: e.message } );
            this.keylessInstance._showUI('txnFailed');

            kl_log('Error avoided', e ); 
        }

        return false;
    }

    async _signTransaction( rawTx, pin, chainId ){
        // kl_log('TX', rawTx );

        let signedTx, chainName, signed, decKey;
        let state = {};
        switch( blockchainInfo[ chainId ].chain_name ){
            case 'ethereum':
            // case 'polygon':
                chainName = blockchainInfo[ chainId ].chain_name;
                this.vault.changeNetwork( chainName );

                const mstate = Storage.getState();

                const mdecKey = mstate.decriptionKey.reduce( ( acc, el, idx ) => { acc[idx]=el;return acc;}, {} );
                await this.vault.restoreKeyringState( mstate.vault, parseInt( pin ), mdecKey );

                rawTx.from = rawTx.from.substr(0, 2)+ rawTx.from.substr(-40).toLowerCase();

                kl_log('before raw', rawTx );

                signed = await this.vault.signTransaction( rawTx, pin, this.getNodeURI( chainId ) );
                kl_log( signed );

                return signed.response;
            break;

            case 'polygon':
                kl_log("IN POLYGON FLOW");
                const someState = Storage.getState();

                chainName = blockchainInfo[ chainId ].chain_name;
                this.vault.changeNetwork( chainName );
                
                kl_log( someState );

                const pdecKey = someState.decriptionKey.reduce( ( acc, el, idx ) => { acc[idx]=el;return acc;}, {} );
                await this.vault.restoreKeyringState( someState.vault, parseInt( pin ), pdecKey );

                rawTx.from = rawTx.from.substr(0, 2)+ rawTx.from.substr(-40).toLowerCase();

                kl_log('before raw', rawTx );

                signed = await this.vault.signTransaction( rawTx, pin, this.getNodeURI( chainId ) );
                kl_log( signed );

                return signed.response;
                return {};
            break;


            // case 'mumbai':
            //     chainName = blockchainInfo[ chainId ].chain_name == 'mumbai'? 'polygon' : blockchainInfo[ chainId ].chain_name;
            //     kl_log( 'chn', chainName );
            //     this.vault.changeNetwork( chainName );

            //     state = Storage.getState();
            //     decKey = state.decriptionKey.reduce( ( acc, el, idx ) => { acc[idx]=el;return acc;}, {} );
            //     await this.vault.restoreKeyringState( state.vault, parseInt( pin ), decKey );
                
            //     rawTx.from = rawTx.from.substr(0, 2)+ rawTx.from.substr(-40).toLowerCase();

            //     signed = await this.vault.signTransaction( rawTx, pin, this.getNodeURI( chainId ) );
            //     kl_log( signed )

            //     return signed.response;
            // break;
            case 'mumbai':
                const state = Storage.getState();
                const decKey = state.decriptionKey.reduce( ( acc, el, idx ) => { acc[idx]=el;return acc;}, {} );
                await this.vault.restoreKeyringState( state.vault, parseInt( pin ), decKey );
                
                const acc = await this.vault.getAccounts( decKey );
                const addr = rawTx.from.substr(0, 2)+ rawTx.from.substr(-40).toLowerCase();

                kl_log( addr, parseInt( pin ) );

                const privateKey = (await this.vault.exportPrivateKey( addr, parseInt( pin ) )).response;
                kl_log('pkey', privateKey );

                const customChainParams = { name: 'matic-mumbai', chainId: 80001, networkId: 80001 }
                const common = Common.forCustomChain('goerli', customChainParams );
                const tx = Transaction.fromTxData({ ...rawTx, nonce: rawTx.nonce }, { common })
                const pkey = Buffer.from( privateKey, 'hex');

                const signedTransaction = tx.sign( pkey );
                kl_log( 'signed', signedTransaction );
                const signedTx = bufferToHex(signedTransaction.serialize());
                return signedTx;
            break;

            default: 
                const dstate = Storage.getState();
                const ddecKey = dstate.decriptionKey.reduce( ( acc, el, idx ) => { acc[idx]=el;return acc;}, {} );
                await this.vault.restoreKeyringState( dstate.vault, parseInt( pin ), ddecKey );

                return (await this.vault.signTransaction( rawTx, pin, this.getNodeURI( chainId ) )).response;
            break;
        }
        
        return signedTx;
    }

    async _createRawTransaction( trans ){
        const chain = this.keylessInstance.getCurrentChain();
        const count = await this.web3.eth.getTransactionCount( trans.data.from );
        kl_log( 'trans d', trans.data );

        let config = {};

        switch( blockchainInfo[ chain.chainId ].chain_name ){
            case 'ethereum':
                config = {
                    to: trans.data.to,
                    from: trans.data.from,
                    value: trans.data.value,
                    gasLimit: this.web3.utils.numberToHex( trans.data.gasLimit ),
                    maxFeePerGas: this.web3.utils.numberToHex( this.web3.utils.toWei( parseFloat( trans.data.maxFeePerGas ).toFixed(2).toString(), 'gwei') ),
                    maxPriorityFeePerGas: this.web3.utils.numberToHex( this.web3.utils.toWei( parseFloat( trans.data.maxPriorityFeePerGas ).toFixed(2).toString(), 'gwei') ),
                    nonce: count
                }
            break;

            case 'polygon':
                config = {
                    to: trans.data.to,
                    from: trans.data.from,
                    value: trans.data.value,
                    gasLimit: this.web3.utils.numberToHex( trans.data.gasLimit ),
                    maxFeePerGas: this.web3.utils.numberToHex( this.web3.utils.toWei( parseFloat( trans.data.maxFeePerGas ).toFixed(2).toString(), 'gwei') ),
                    maxPriorityFeePerGas: this.web3.utils.numberToHex( this.web3.utils.toWei( parseFloat( trans.data.maxPriorityFeePerGas ).toFixed(2).toString(), 'gwei') ),
                    nonce: count,
                    type: '0x2',
                    chainId: chain.chainId
                }
            break;

            case 'ropsten':
                config = {
                    to: trans.data.to,
                    from: trans.data.from,
                    value: trans.data.value,
                    gasLimit: this.web3.utils.numberToHex( trans.data.gasLimit ),
                    maxFeePerGas: this.web3.utils.numberToHex( this.web3.utils.toWei( parseFloat( trans.data.maxFeePerGas ).toFixed(2).toString(), 'gwei') ),
                    maxPriorityFeePerGas: this.web3.utils.numberToHex( this.web3.utils.toWei( parseFloat( trans.data.maxPriorityFeePerGas ).toFixed(2).toString(), 'gwei') ),
                    nonce: count
                }
            break;

            case 'mumbai':
                config = {
                    to: trans.data.to,
                    from: trans.data.from,
                    value: trans.data.value.indexOf('0x') != -1? trans.data.value : this.web3.utils.toWei( trans.data.value.toString(), 'ether'),
                    gasLimit: this.web3.utils.numberToHex( 40000 ),
                    gasPrice: this.web3.utils.toHex( this.web3.utils.toWei( parseFloat( trans.data.maxFeePerGas ).toFixed(2).toString(), 'gwei') ),
                    nonce: count,
                    chainId: chain.chainId
                }
                kl_log( 'mumbai trans', config );
            break;
        }
        return config;
    }

    getActiveChainExplorer(){
        const chain = this.keylessInstance.getCurrentChain();
        return blockchainInfo[ chain.chainId ].explorer;
    }

    async _signMessage( pin ){
        if( this.activeSignRequest ){
            const state = Storage.getState();
            const rpcUrl = this.getNodeURI( this.keylessInstance.getCurrentChain().chainId );
            kl_log( this.activeSignRequest.data, this.activeSignRequest.address, pin, rpcUrl );

            try {
                const decKey = state.decriptionKey.reduce( ( acc, el, idx ) => { acc[idx]=el;return acc;}, {} );
                await this.vault.restoreKeyringState( state.vault, pin, decKey );
                kl_log( this.vault.decryptedVault );
                
                const acc = await this.vault.exportPrivateKey( this.activeSignRequest.address.toString(), parseInt( pin ) );
                // kl_log(acc);
            
            
                const trans = await this.vault.sign( this.activeSignRequest.data, this.activeSignRequest.address.toString(), parseInt( pin ), rpcUrl );
                if( trans.hasOwnProperty('error') ){
                    this.activeSignRequest.reject( {
                        message: trans.error,
                        code: 4200,
                        method: 'Sign Message'
                    } );
                } else {
                    this.activeSignRequest.resolve( trans.response );
                }
                this.keylessInstance._hideUI();
                kl_log( trans );

                return trans?.response;
            } catch( e ){
                this.activeSignRequest.reject( {
                    message: e,
                    code: 4200,
                    method: 'Sign Message'
                } );
                this.keylessInstance._hideUI();
                return false;
            }
            
        }
    }

    async getSafleIdFromAddress( address ){
        const node_uri = await this.getNodeURI( this.keylessInstance.getCurrentChain().chainId );
        const safleId = new safleIdentity( this.keylessInstance._env == 'dev'? 'testnet' : 'mainnet', node_uri );
        try {
            const safleID = await safleId.getSafleId( address );
            kl_log('SafleID: ', safleID );
            return safleID.indexOf('Invalid') != -1? false : safleID;
        } catch( e ){
            kl_log('error', e );
            return false;
        }
    }

    clearActiveTransaction(){
        this.activeTransaction = null;
        this.activeSignRequest = null;
    }




    async getRequest( { url } ){
        const resp = await fetch( url ).then( e => e.json() ).catch( e => {
            kl_log('error fetching estimats', e );
            return null;
        });
        return resp;
    }

    _setLoading( flag ){
        const inst = this.keylessInstance._activeScreen;
        if( inst && inst.hasOwnProperty('el') ){
            flag? inst.el.classList.add('loading') : inst.el.classList.remove('loading')
        }
    }

    _setBlockchainRPC( config ){
        for( var i in blockchainInfo ){
            const curr = config.find( e => e.chainId == i );
            if( curr ){
                blockchainInfo[ i ].rpcURL = curr.rpcURL;
            }
        }
    }

    async _getIsVaultMobile( user ){
        let res = await fetch(`${process.env.AUTH_URL}/auth/safleid-status/${user}`).then(e=>e.json());
        if( res.statusCode !== 200 ){
            return null;
        }
        return res.data?.vaultStorage?.mobile == true;
    }

    _sanitizeTransaction( config ){
        try {
            const allowedParams = ['from', 'to', 'value', 'gas', 'gasPrice', 'nonce', 'maxPriorityFeePerGas', 'maxFeePerGas', 'data', 'type', 'chainId'];
            let illegalAttr = false;
            for( var i in config ){
                if( allowedParams.indexOf( i ) == -1 ){
                    illegalAttr = i;
                };
            }
            if( illegalAttr ){
                throw new Error(`Invalid transaction attribute "${illegalAttr}"`);
            }
            return config;
        } catch ( e ){
            console.error( e.message );
            return false;
        }
    }

    async loadTokenData() {
        const tokenData = await fetch('https://raw.githubusercontent.com/getsafle/multichain-data/main/assets.json').then( e => e.json() );
        this.tokenData = tokenData;
    }

    getTokenIcon( token ){
        const addr = token.tokenAddress;
        const chain = blockchainInfo[ this.keylessInstance.getCurrentChain()?.chainId ].chain_name;
        // kl_log('tokendata', this.tokenData );

        if( Object.values( this.tokenData ).length == 0 ){
            return null;
        }

        const found = this.tokenData.chains.hasOwnProperty( chain ) && this.tokenData.chains[chain].CONTRACT_MAP.hasOwnProperty( addr )? this.tokenData.chains[chain].CONTRACT_MAP[ addr ].logo : null;
        return found;
    }
}

export default KeylessController;