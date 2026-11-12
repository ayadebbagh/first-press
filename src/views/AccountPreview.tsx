import {AppLink} from '../state/Navigation.tsx';
import {Icon} from '../components/Primitives.tsx';

// File previews cannot run the server-backed identity flow. Keep navigation
// inside the preview and explain that boundary instead of opening file:///account.
export function AccountPreview(){
 return <section className="account-preview"><span className="eyebrow">YOUR SIDE OF THE SCENE</span><h1>YOUR<br/><em>ACCOUNT.</em></h1><div className="account-preview-note"><span className="tiny">FILE PREVIEW</span><h2>You're exploring the demo.</h2><p>Your demo collection and Credits are saved on this device. Connected sign-in is available in the running FIRST PRESS app.</p><p>This preview doesn't create an account or verified backing history.</p><AppLink to="/discover" className="button red">Back to discovery <Icon name="arrow" size={18}/></AppLink></div></section>;
}
