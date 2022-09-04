import abiDecoder from 'abi-decoder';
import TokenController from '@getsafle/custom-token-controller';
import erc20ABI from './erc20-abi';

import cryptoRandomString from 'get-random-values';
// import axios from 'axios';
import crypto from 'crypto-browserify';
import aes from 'aes-js';
import APIS from '../helpers/apis';
// import Vault from '@getsafle/safle-vault';
import { kl_log } from './../helpers/helpers';
const ethers = require('ethers');
const KDFiterations = 10000;

export const login = async ( safleID, password, token ) => {
    // kl_log( safleID, password );

    let passwordDerivedKey = await generatePDKey({safleID, password});
    const pdkeyHash = await createPDKeyHash({ passwordDerivedKey });

    let params = {
        "userName": safleID,
        "password": pdkeyHash,
        "g-recaptcha-response": token
    };

    const resp = await fetch( APIS.login, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(params)
    }).then( r => r.json() ).then( resp => resp).catch( (err)=> {
        return Promise.reject( err );
    });
    if( resp.statusCode == 201 ){
        return resp;
    } else {
        return Promise.reject( resp );
    }

    await delay_code( 1000 );

    return resp;
}



export function generateRandomNumber() {
    let firstNumber = Math.floor(Math.random() * 11 + 1);
    let secondNumber = Math.floor(Math.random() * 11 + 1);

    while (secondNumber === firstNumber) {
        secondNumber = Math.floor(Math.random() * 11 + 1);
    }

    return { response: { firstNumber, secondNumber } };
};

// Method to generate encryption key
export async function generateEncryptionKey() {
    const bytes = new Uint8Array(64);
    const encryptionKey = cryptoRandomString(bytes);
    return encryptionKey
}

// Method to generate pdkey
export async function generatePDKey({ safleID, password }) {
    const passwordDerivedKey = crypto.pbkdf2Sync(password, safleID, 10000, 32, 'sha512');
    // //kl_log('DERIVED KEY', passwordDerivedKey.toString('hex') );
 
    const passwordDerivedKeyHash = crypto.createHash('sha256');
    passwordDerivedKeyHash.update( passwordDerivedKey, 'utf8' );

    const passwordDerivedKeyHashHex = passwordDerivedKeyHash.digest(); //Buffer.from( passwordDerivedKeyHash.digest() );
    return Promise.resolve( passwordDerivedKeyHashHex );
}

// Method to encrpty encryption key
export async function encryptEncryptionKey({ passwordDerivedKey, encryptionKey }) {
    // const passBytes = aes.utils.hex.toBytes( passwordDerivedKey );
    const aesCBC = new aes.ModeOfOperation.cbc( Buffer.from( passwordDerivedKey ) );
    const encryptedEncryptionKey = aesCBC.encrypt( Object.values( encryptionKey ) );
    //kl_log("Encrypted Encryption Key : ", encryptedEncryptionKey);
    return encryptedEncryptionKey
}

// Method to create pdkey hash
export async function createPDKeyHash({ passwordDerivedKey }) {
    const passwordDerivedKeyHash = crypto.createHash('sha512');
    passwordDerivedKeyHash.update( passwordDerivedKey );
    const passwordDerivedKeyHashHex = passwordDerivedKeyHash.digest('hex')
    //kl_log("Password derived key hash : ", passwordDerivedKeyHashHex);
    return passwordDerivedKeyHashHex
}

// Method to generate hashed password
export async function hashPassword({ password, passwordDerivedKey }) {
    const passwordHash = crypto.pbkdf2Sync(passwordDerivedKey, password, 1 , 32, 'sha512');
    const passwordHashHex = passwordHash.toString('hex')
    //kl_log('Password Hash : ', passwordHashHex);
    return passwordHashHex
}


// retrieve cloud functions
export const getCloudToken = async( user, pass, gtoken ) => {
    try {
        const derivedKey = await generatePDKey({safleID: user, password: pass });
        const PDKeyHash = await createPDKeyHash( { passwordDerivedKey: derivedKey } );

        const jwtToken = await fetch( APIS.login, {
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json'
            },
            method: 'POST',
            body: JSON.stringify( { userName: user, password: PDKeyHash, 'g-recaptcha-response': gtoken.toString() } )
        } ).then( resp => resp.json() );
        
        if( jwtToken.statusCode == 201 ){
            return jwtToken.data.token;
        } else {
            Promise.reject( new Error( jwtToken.info[0].message ) );
        }            
    } catch( e ){
        Promise.reject( new Error( e.message ) );
    }
}
export const retrieveVaultFromCloud = async( PDKeyHash, authToken ) => {
    try {
        const req = await fetch( APIS.retrieve_vault, {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${authToken}`
            },
            method: 'POST',
            body: JSON.stringify( { PDKeyHash } )
        }).then( resp => resp.json() ).catch(  ( e ) => { 
            return Promise.reject( new Error( e.message ) );
        });
        return req.data?.data?.vault;

    } catch( e ){
        return Promise.reject( new Error( e.message ) );
    }    
}

export const retrieveEncryptionKey = async( PDKeyHash, authToken ) => {
    try {
        const req = await fetch( APIS.retrieve_encription_key, {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${authToken}`
            },
            method: 'POST',
            body: JSON.stringify( { PDKeyHash } )
        }).then( resp => resp.json() ).catch(  ( e ) => { 
            kl_log( e );
            return Promise.reject( new Error( e.message ) );
        });

        return req.data?.encryptedEncryptionKey;
    } catch( e ){
        kl_log( e );
        return Promise.reject( new Error( e.message ) );
    }
}

export const decryptEncryptionKey = ( safleID, password, encryptedEncryptionKey, ret='array' ) => {
    const aes = require('aes-js');

    function generatePDKey({ safleID, password }) {
        const passwordDerivedKey = crypto.pbkdf2Sync(password, safleID, 10000, 32, 'sha512');
        const passwordDerivedKeyHash = crypto.createHash('sha256');
        passwordDerivedKeyHash.update( passwordDerivedKey, 'utf8' );
        const passwordDerivedKeyHashHex = Buffer.from( passwordDerivedKeyHash.digest() );
        return passwordDerivedKeyHashHex;
    }

    let passwordDerivedKey = generatePDKey({safleID, password});
    const k = Array.from( passwordDerivedKey );

    const aesCBC = new aes.ModeOfOperation.cbc( k );
    const decriptedKey = aesCBC.decrypt( encryptedEncryptionKey );
    if( ret == 'object'){
        return decriptedKey;
    }
    if( typeof decriptedKey === 'object'){
        return Object.values( decriptedKey );
    }
    return decriptedKey;
}



export async function decodeInput(input, rpcUrl, contractAddress) {
    abiDecoder.addABI(erc20ABI);
    
    const functionName = await extractFunctionName(input);

    const decodedData = abiDecoder.decodeMethod(input);
    
    const tokenController = new TokenController.CustomTokenController({ rpcURL: rpcUrl, chain: 'polygon' });
  
    const tokenDetails = await tokenController.getTokenDetails(contractAddress);
  
    let output;
  
    switch (functionName) {
  
      case 'Transfer':
        output = {
          tokenSymbol: tokenDetails.symbol,
          recepient: decodedData.params[0].value,
          value: decodedData.params[1].value/10**parseInt(tokenDetails.decimal),
        }
  
        break;
  
      case 'Transfer From':
        output = {
          from: decodedData.params[0].value,
          tokenSymbol: tokenDetails.symbol,
          recepient: decodedData.params[1].value,
          value: decodedData.params[2].value/10**parseInt(tokenDetails.decimal),
        }
  
        break;
  
    }
    return output;
}

export async function extractFunctionName(input) {
    let functionName;

    const sigs = {
        '0xa9059cbb': 'Transfer',
        '0x23b872dd': 'Transfer From',
    }
  
    const signature = input.substring(0, 10);
  
    if (sigs[signature] === undefined) {
        functionName = signature;
    } else {
        functionName = sigs[signature];
    }
  
    return functionName;
}