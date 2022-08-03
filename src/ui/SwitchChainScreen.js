import logoImg from './../images/logo.svg';
import closeImg from './../images/close.png';
import network2 from './../images/network-2.svg'
// import network3 from './../images/network-3.svg'
// import network4 from './../images/network-4.svg'
// import network5 from './../images/network-5.svg'
// import network6 from './../images/network-6.svg'
import tokenIcon from './../images/token-icon.webp'
// import user2 from './../images/user-2.webp'
// import user3 from './../images/user-3.webp'
// import user4 from './../images/user-4.webp'
import popoutImg from './../images/pop-out.svg'
import UIScreen from '../classes/UIScreen';
import Dropdown from './components/DropDown';
import AddressDropdown from './components/AddressDropdown';
import { kl_log } from '../helpers/helpers';

class SwitchChainScreen extends UIScreen {
    currentChain;
    activeWallet;
    chosenAddress = false;

    async onShow(){
        this.activeWallet = this.keyless.kctrl.activeWallet || 0;
        this.chosenAddress = this.keyless.kctrl.wallets[this.activeWallet].address;
        this.currentChain = this.keyless.getCurrentChain().chainId;

        // on close
        this.el.querySelector('.close').addEventListener('click', () => {
            // this.keyless.kctrl._loginSuccess();
            this.keyless._connected = false;
            this.keyless._hideUI();
        });

        this.mount = this.el.querySelector('#mount_dropdowns');
        this.mount.innerHTML = '';

        const chains = this.keyless.kctrl.getChainsOptions( this.keyless.allowedChains );
        let addreses = [{ label: '', balance: ''}];

        const initial =  chains.find( e => this.keyless.getCurrentChain().chainId == e.chainId )
        // const initial = this.keyless.getCurrentChain().chain

        this.dropdown1 = new Dropdown( this.mount, 'dropdown__tp--1', 'dropdown__content--1', chains, { initial } );
        this.dropdown2 = new AddressDropdown( this.mount, 'dropdown__tp--1', 'dropdown__content--2', addreses, this.keyless.getCurrentNativeToken(), this.chosenAddress );

        this.dropdown1.onChange( async ( idx, option ) => {
            this.currentChain = option.chainId

            const localWeb3Obj = this.keyless.kctrl.generateWeb3Object(this.currentChain);
            this.dropdown2.setLoading( true );
            this.keyless.kctrl._setLoading( true );
            const addreses = await this.keyless.kctrl.getAddressesOptions( this.keyless.kctrl.wallets, localWeb3Obj );
            this.dropdown2.setLoading( false );
            this.keyless.kctrl._setLoading( false );
            // this.dropdown2.setOptions( addreses );
            // kl_log('PLM', this.keyless.getCurrentNativeToken() );
            const nativeToken = await this.keyless.getNativeTokenFor( option.chainId );
            this.dropdown2.update( addreses, nativeToken.toUpperCase(), this.chosenAddress );
        });

        this.dropdown2.onChange( ( wid, wallet ) => {
            this.activeWallet = wid;
            this.chosenAddress = this.keyless.kctrl.wallets[ wid ];
        });

        this.el.querySelector('#proceed_btn').addEventListener('click', () => {
            this.keyless._hideUI();
            kl_log('CURR', this.currentChain );

            this.keyless.switchNetwork( this.currentChain );
            this.keyless.switchWallet( this.activeWallet );

            this.keyless._loggedin = true;
            this.keyless.kctrl._loginSuccess();
        });

        this.keyless.kctrl._setLoading( true );
        addreses = await this.keyless.kctrl.getAddressesOptions( this.keyless.kctrl.getAccounts(true) );
        this.dropdown2.update( addreses, this.keyless.getCurrentNativeToken(), this.chosenAddress );

        this.keyless.kctrl._setLoading( false );
    }

    _renderLoadingDropDowns(){
        return `<div>
        <div class="dropdown_default dropdown_address loading dropdown1">
            <div class="title_label" style="justify-content: space-between;width: 100%;">
                <div>
                    <img class="title_icon" src="" alt="Network Icon">
                    <h3></h3>
                </div>
                <div class="balance">
                    <h3><span class="c--dark"></span></h3>
                    <svg aria-hidden="true" focusable="false" data-prefix="fas" data-icon="angle-down" class="svg-inline--fa fa-angle-down fa-w-10" width="16" height="10" xmlns="http://www.w3.org/2000/svg">
                        <path d="m8 10 .88-.843L16 2.316 14.241 0 8 5.998 1.759 0 0 2.316A277265.12 277265.12 0 0 0 8 10z" fill="#CBD7E9" fill-rule="nonzero"/>
                    </svg>
                </div>
            </div>    
        </div></div>
        <div>
        <div class="dropdown_default dropdown_address loading dropdown1">
            <div class="title_label" style="justify-content: space-between;width: 100%;">
                <div>
                    <img class="title_icon" src="" alt="Network Icon">
                    <h3></h3>
                </div>
                <div class="balance">
                    <h3><span class="c--dark"></span></h3>
                    <svg aria-hidden="true" focusable="false" data-prefix="fas" data-icon="angle-down" class="svg-inline--fa fa-angle-down fa-w-10" width="16" height="10" xmlns="http://www.w3.org/2000/svg">
                        <path d="m8 10 .88-.843L16 2.316 14.241 0 8 5.998 1.759 0 0 2.316A277265.12 277265.12 0 0 0 8 10z" fill="#CBD7E9" fill-rule="nonzero"/>
                    </svg>
                </div>
            </div>    
        </div></div>
        `;
    }

    hideDropdowns(){
        Array.from( document.querySelectorAll('.dropdown__content--1,.dropdown__content--2') ).forEach( ( el ) => {
            el.classList.add('d--none');
        });
    }

    render(){

        return `<div class="chain">

        <img class="close" src="${closeImg}" alt="Close Icon">

        <a class="logo" href="#">
            <img src="${logoImg}" alt="Safle Logo">
        </a>

        <div id="mount_dropdowns"></div>

        <button class="btn__tp--1" id="proceed_btn">Proceed</button>
        <button class="btn__tp--2 c--gray">
            Open Wallet
            <img src="${popoutImg}" alt="Open Wallet Pop Out Icon">
        </button>

    </div>`
    }

}

export default SwitchChainScreen;