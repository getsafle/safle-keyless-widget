import Web3 from 'web3';
import blockchainInfo from './../helpers/blockchains';
import { middleEllipsis, formatPrice, formatXDecimals } from './../helpers/helpers';
import * as safleHelpers from './../helpers/safleHelpers';
import Storage from './../classes/Storage';
import Vault from '@getsafle/safle-vault';
import asset_controller  from '@getsafle/asset-controller';
const safleIdentity = require('@getsafle/safle-identity-wallet').SafleID;

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
            console.log('CHAINID on signin', this.activeChain );
            this.activeWallet = sessionActiveWallet;
        }
        const nodeURI = this.getNodeURI(this.activeChain?.chainId);
        
        this.web3 = new Web3( new Web3.providers.HttpProvider( nodeURI ));
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
                console.log( acc );

                this.wallets = acc.response.map( e => { return { address: e.address }} ) || [];
                console.log( this.wallets );
            } catch( e ){
                this.wallets = [];
                console.log( e );
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
        this._setLoading( true );
        console.log('login with user '+user+', pass '+pass );

        this._isMobileVault = await this._getIsVaultMobile( user );
        console.log( this._isMobileVault );

        await grecaptcha.execute();
        let captchaToken = grecaptcha.getResponse();
        // console.log( token );
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
        // console.log( encKey );

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

    _loginSuccess(){
        const addreses = this.getAccounts();
        this.keylessInstance.provider.emit('login successful', addreses );
    }

    // re-build web3 instance for the current blockchain
    switchNetwork( chainId){
        console.log( 'rebuild web3 object for EVM chainId ', chainId );
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
        this.activeTransaction = {
            data: config,
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
        console.log( 'gettokens', address, chain, this.getNodeURI() );
        const assets = new asset_controller.AssetController({ chain , rpcURL: this.getNodeURI() });
        const erc20Balance = await assets.detectTokens({ tokenType: 'erc20', userAddress: address });

        return erc20Balance;
    }

    // option transformers
    getChainsOptions( options ){
        return options.map( chain => {
            // console.log( chain );
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
        // console.log( balances );

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
        // console.log('KeylessController._getWalletBalances', balances );
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
            console.log( 'KeylessController.getBalanceInUSD',  balance, priceUSD );
            return formatXDecimals( parseFloat( balance ) * parseFloat( priceUSD ), 3 );
        } catch( e ){
            console.log('Error fetching usd balance', e.message );
            return 0;
        }
    }

    async getCurrentNativeToken(){
        let activeChain = await this.keylessInstance.getCurrentChain();
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

                // console.log( resp );

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
            return response;
        } catch( e ){
            console.log('error', e );
            return null;
        }
    }

    async checkPin( pin ){
        try {
            const v = await this.vault.validatePin( parseInt( pin ) );
            // console.log( v );
            return v.response;
        } catch( e ){
            // console.log( e.message );
            return false;
        }
    }

    async _createAndSendTransaction( pin ) {
        const chain = this.keylessInstance.getCurrentChain();
        const trans = this.activeTransaction;
        if( !trans ){
            console.log('transaction does not exist');
            return;
        }
        console.log( trans );
        
        const rawTx = await this._createRawTransaction( trans );
        rawTx.from = rawTx.from.substr(0, 2)+ rawTx.from.substr(-40).toLowerCase();
        rawTx.to = rawTx.to.substr(0, 2)+ rawTx.to.substr(-40).toLowerCase();
        
        const state = Storage.getState();
        const decKey = state.decriptionKey.reduce( ( acc, el, idx ) => { acc[idx]=el;return acc;}, {} );
        this.vault.restoreKeyringState( state.vault, pin, decKey );

        const chainName = chain.chain.rpcURL.indexOf('polygon') != -1? 'polygon' : 'ethereum';
        // this.vault.changeNetwork( chainName );

        console.log('RAW', rawTx );

        const signedTx = await this._signTransaction( rawTx, pin, chain.chainId );
        console.log( 'signed', signedTx );
        const tx = this.web3.eth.sendSignedTransaction( signedTx );
        try {
            tx.once('transactionHash', ( hash ) => {
                console.log( 'txn hash', hash );
                this.transactionHashes.push( hash );
                this.keylessInstance._showUI('txnSuccess');

            }).once('receipt', ( err, txnReceipt ) => {
                console.log('receipt', receipt );
                this.keylessInstance.provider.emit('transactionComplete', { receipt } );
                if( txnReceipt.status == 1 ){
                    this.keylessInstance.provider.emit('transactionSuccess', { receipt } );
                } else {
                    this.keylessInstance._showUI('txnFailed'); 
                    this.keylessInstance.provider.emit('transactionFailed', { receipt } );
                }
            }).on('confirmation', ( confNr, receipt ) => {
                console.log('confirmations', confNr );
                console.log('receipt', receipt );
            }).once('error', ( e, receipt ) => {
                // console.log('errror', e );
                console.log('txn', receipt );
                this.keylessInstance.provider.emit('transactionFailed', { receipt } );

                this.keylessInstance._showUI('txnFailed');                 
            })
            .then( receipt => {
                console.log('receipt', receipt );
               // this.keyless._showUI('txnSuccess');
               this.keylessInstance.provider.emit('transactionSuccess', { receipt } );
            }).catch( err => { console.log('uncaught', err ) });
        } catch ( e ){
            console.log('Error avoided'); 
        }

        return false;
    }

    async _signTransaction( rawTx, pin, chainId ){
        // console.log('TX', rawTx );

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

                console.log('before raw', rawTx );

                signed = await this.vault.signTransaction( rawTx, pin, this.getNodeURI( chainId ) );
                console.log( signed );

                return signed.response;
            break;

            case 'polygon':
                console.log("IN POLYGON FLOW");
                const someState = Storage.getState();

                chainName = blockchainInfo[ chainId ].chain_name;
                this.vault.changeNetwork( chainName );
                
                console.log( someState );

                const pdecKey = someState.decriptionKey.reduce( ( acc, el, idx ) => { acc[idx]=el;return acc;}, {} );
                await this.vault.restoreKeyringState( someState.vault, parseInt( pin ), pdecKey );

                rawTx.from = rawTx.from.substr(0, 2)+ rawTx.from.substr(-40).toLowerCase();

                console.log('before raw', rawTx );

                signed = await this.vault.signTransaction( rawTx, pin, this.getNodeURI( chainId ) );
                console.log( signed );

                return signed.response;
                return {};
            break;


            // case 'mumbai':
            //     chainName = blockchainInfo[ chainId ].chain_name == 'mumbai'? 'polygon' : blockchainInfo[ chainId ].chain_name;
            //     console.log( 'chn', chainName );
            //     this.vault.changeNetwork( chainName );

            //     state = Storage.getState();
            //     decKey = state.decriptionKey.reduce( ( acc, el, idx ) => { acc[idx]=el;return acc;}, {} );
            //     await this.vault.restoreKeyringState( state.vault, parseInt( pin ), decKey );
                
            //     rawTx.from = rawTx.from.substr(0, 2)+ rawTx.from.substr(-40).toLowerCase();

            //     signed = await this.vault.signTransaction( rawTx, pin, this.getNodeURI( chainId ) );
            //     console.log( signed )

            //     return signed.response;
            // break;
            case 'mumbai':
                const state = Storage.getState();
                const decKey = state.decriptionKey.reduce( ( acc, el, idx ) => { acc[idx]=el;return acc;}, {} );
                await this.vault.restoreKeyringState( state.vault, parseInt( pin ), decKey );
                
                const acc = await this.vault.getAccounts( decKey );
                const addr = rawTx.from.substr(0, 2)+ rawTx.from.substr(-40).toLowerCase();

                console.log( addr, parseInt( pin ) );

                const privateKey = (await this.vault.exportPrivateKey( addr, parseInt( pin ) )).response;
                console.log('pkey', privateKey );

                const customChainParams = { name: 'matic-mumbai', chainId: 80001, networkId: 80001 }
                const common = Common.forCustomChain('goerli', customChainParams );
                const tx = Transaction.fromTxData({ ...rawTx, nonce: rawTx.nonce }, { common })
                const pkey = Buffer.from( privateKey, 'hex');

                const signedTransaction = tx.sign( pkey );
                console.log( 'signed', signedTransaction );
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
        console.log( 'trans d', trans.data );

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
                console.log( 'mumbai trans', config );
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
            console.log( this.activeSignRequest.data, this.activeSignRequest.address, pin, rpcUrl );

            const decKey = state.decriptionKey.reduce( ( acc, el, idx ) => { acc[idx]=el;return acc;}, {} );
            await this.vault.restoreKeyringState( state.vault, pin, decKey );
            console.log( this.vault.decryptedVault );
            
            const acc = await this.vault.exportPrivateKey( this.activeSignRequest.address.toString(), parseInt( pin ) );
            // console.log(acc);
            
            try {
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
                console.log( trans );

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
        const safleId = new safleIdentity( process.env.SAFLE_ENV == 'dev'? 'testnet' : 'mainnet' );
        try {
            const safleID = await safleId.getSafleId( address );
            console.log('SafleID: ', safleID );
            return safleID.indexOf('Invalid') != -1? false : safleID;
        } catch( e ){
            console.log('error', e );
            return false;
        }
    }





    async getRequest( { url } ){
        const resp = await fetch( url ).then( e => e.json() ).catch( e => {
            console.log('error fetching estimats', e );
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
}

export default KeylessController;