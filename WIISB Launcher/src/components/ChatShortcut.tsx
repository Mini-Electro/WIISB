import {useState} from 'react';
import {invoke} from '@tauri-apps/api/core';
import {MessageCircle,Loader2} from 'lucide-react';
import {cx,Tooltip} from './ui';
export function ChatShortcut({collapsed}:{collapsed:boolean}) {
 const [busy,setBusy]=useState(false),[error,setError]=useState('');
 const launch=async()=>{setError('');setBusy(true);try{await invoke('launch_wiisb_chat');}catch(e){setError(e&&typeof e==='object'&&'message' in e?String(e.message):String(e));}finally{setBusy(false);}};
 const button=<button type="button" aria-label="Launch WIISB Chat" disabled={busy} onClick={()=>void launch()} className={cx('flex h-11 w-full items-center gap-3 rounded-ctl text-sm font-semibold text-muted t-transition wash hover:text-fg',collapsed?'justify-center':'px-3.5')}>
 {busy?<Loader2 size={19} className="spin"/>:<MessageCircle size={19} className="text-accent2"/>}{!collapsed&&<span>WIISB Chat</span>}</button>;
 return <div className="mt-auto border-t border-line pt-4">{!collapsed&&<div className="px-3.5 pb-2 text-[10px] font-bold tracking-[0.16em] text-muted">OTHER</div>}{collapsed?<Tooltip label={error||'Launch WIISB Chat'} side="right">{button}</Tooltip>:button}{error&&!collapsed&&<p role="alert" className="px-3.5 pt-2 text-[11px] leading-relaxed text-danger">{error}</p>}</div>;
}
