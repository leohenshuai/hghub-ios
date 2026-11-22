import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef } from "react";
import Hls from "hls.js";
import workerPath from 'hls.js/dist/hls.worker.js?url';
import { hlsPlaybackPath } from '../plugins/mediaCapabilities';
import { playbackTiming } from '../plugins/playbackTiming';
import { pluginCommand, type PreparedMedia } from "../plugins/client";

export interface VideoHandle {
  el: () => HTMLVideoElement | null;
  play: () => void; pause: () => void; toggle: () => void;
  seek: (time: number, source?: string) => void;
  rate: (rate: number) => void; mute: (muted: boolean) => void; volume: (volume: number) => void;
}
interface Props {
  media: PreparedMedia; position: number; active: boolean; autoPlay?: boolean;
  poster?: string; muted: boolean; volume: number; rate: number; fit: "contain" | "cover";
  scale: number; panX: number; panY: number; isGesturing: boolean;
  onClick: () => void; onTime: (t: number) => void; onDuration: (d: number) => void;
  onSize: (w: number,h: number) => void; onBuffered: (fraction: number) => void;
  onBuffer?: (seconds: number) => void;
  onPlaying: () => void; onPause: () => void; onWaiting: () => void;
  onEnded?: () => void; onError: () => void;
}

/** Same surface/handle as the original player, loading only host-prepared media URLs. */

/** 播放器错误进入诊断中心：MediaError.code 决定问题方向（2 网络/Range，3 解码，4 格式或 MIME 不被接受）。只记代码与 HTTP 状态，不记地址。 */
const MEDIA_ERR: Record<number, string> = { 1: "ABORTED", 2: "NETWORK", 3: "DECODE", 4: "SRC_NOT_SUPPORTED" };
function reportMediaError(v: HTMLVideoElement, media: { format?: string; providerId?: string; diag?: { mediaId: string; episodeId: string; title?: string } }) {
  const err = v.error;
  const code = err?.code ?? 0;
  const name = MEDIA_ERR[code] || "UNKNOWN";
  const plugin = media.providerId || "";
  const where = media.diag ? `「${media.diag.title || media.diag.mediaId}」mediaId=${media.diag.mediaId} ep=${media.diag.episodeId}，` : "";
  const text = `播放器错误 MEDIA_ERR_${name}(${code})，${where}格式 ${media.format ?? "?"}，${err?.message ? err.message.slice(0, 160) : "无详情"}`;
  void pluginCommand("diagnostics.report", { plugin, level: "error", message: text }).catch(() => {});
}
/** 全局只有一个 <video>。
 *  iOS 低电量模式会禁止脚本自动起播（连静音的也不例外），但对「已经被用户手势播放过」的元素，
 *  之后改 src 再 play() 一般放行。推荐流每滑一条都新建一个 <video>，等于每条都要重新申请授权，
 *  于是在低电量下每条都停在播放钮上。改成整个应用共用一个元素，只换 src。
 *  元素由本模块创建并在每次挂载时搬进当前容器；React 不再管理它，所以事件要自己绑。 */
let sharedVideo: HTMLVideoElement | null = null;
function ensureVideo() {
  if (!sharedVideo) {
    const v = document.createElement("video");
    v.playsInline = true; v.preload = "auto"; v.crossOrigin = "anonymous";
    v.setAttribute("playsinline", ""); v.setAttribute("webkit-playsinline", "");
    v.className = "w-full h-full";
    sharedVideo = v;
  }
  return sharedVideo;
}
/** 当前占用者：晚到的卸载不能把已经交给新占用者的元素摘走或清空。 */
let owner: symbol | null = null;

export default forwardRef<VideoHandle, Props>(function VideoSurface(props, forwarded) {
  const ref=useRef<HTMLVideoElement|null>(null), latest=useRef(props), hls=useRef<Hls|null>(null);
  const hostRef=useRef<HTMLDivElement>(null);
  const playAttempt=useRef(0), wantsPlay=useRef(props.autoPlay!==false);
  latest.current=props;
  // 先于所有 effect：保证 ref 在第一个 effect 里就有值
  const attach=()=>{
    const host=hostRef.current;if(!host)return null;
    const v=ensureVideo();
    if(v.parentNode!==host)host.appendChild(v);
    ref.current=v;return v;
  };
  useLayoutEffect(()=>{attach();},[]);
  const play=()=>{
    const v=ref.current;
    if(!v || !latest.current.active || document.hidden)return;
    wantsPlay.current=true;
    const attempt=++playAttempt.current, sessionId=latest.current.media.sessionId;
    if(v.paused || v.readyState<3)latest.current.onWaiting();
    void v.play().catch((error:unknown)=>{
      if(attempt!==playAttempt.current || sessionId!==latest.current.media.sessionId || !latest.current.active || document.hidden)return;
      const name=(error as {name?:string})?.name;
      if(name==='AbortError')return; // Source changes and pause interrupt pending play promises.
      if(name==='NotAllowedError'){
        wantsPlay.current=false;latest.current.onPause();
        // 自动播放被系统拒绝：记进诊断中心，才分得清是「低电量模式 / 非手势触发」还是代码问题。
        const m=latest.current.media;
        void pluginCommand("diagnostics.report",{plugin:m.providerId||"",level:"warn",message:`自动播放被系统拒绝(NotAllowedError)：muted=${v.muted} 页面可见=${!document.hidden} readyState=${v.readyState}`}).catch(()=>{});
        // 兜底：用户在这页上的第一次触摸本身就是合法手势，借它把视频拉起来。
        // 只在被拒之后才挂，且只触发一次，不改变正常路径。
        const kick=()=>{window.removeEventListener("touchend",kick,true);window.removeEventListener("pointerup",kick,true);if(latest.current.active&&ref.current?.paused&&sessionId===latest.current.media.sessionId)play();};
        window.addEventListener("touchend",kick,{capture:true,once:true});window.addEventListener("pointerup",kick,{capture:true,once:true});
      }
      else latest.current.onError();
    });
  };
  const pause=()=>{wantsPlay.current=false;playAttempt.current++;const v=ref.current;if(!v)return;const alreadyPaused=v.paused;v.pause();if(alreadyPaused)latest.current.onPause();};
  useImperativeHandle(forwarded,()=>({
    el:()=>ref.current, play, pause,
    toggle:()=>{const v=ref.current;if(v?.paused)play();else pause();},
    seek:(t)=>{const v=ref.current;if(!v || !Number.isFinite(t) || !Number.isFinite(v.duration))return;const target=Math.max(0,Math.min(v.duration-.15,t));hls.current?.startLoad(target);v.currentTime=target;latest.current.onTime(target);},
    rate:r=>{if(ref.current)ref.current.playbackRate=r;},mute:m=>{if(ref.current)ref.current.muted=m;},volume:n=>{if(ref.current)ref.current.volume=n;},
  }),[]);
  useEffect(()=>{
    const v=attach()!;let disposed=false,failed=false,resume=false;
    const me=Symbol("surface");owner=me;
    playAttempt.current++;wantsPlay.current=latest.current.autoPlay!==false;
    const started=performance.now(); let firstFrame: number | undefined;
    const p=latest.current;
    const activity=(playing:boolean)=>void pluginCommand("media.activity",{sessionId:p.media.sessionId,version:p.media.version,playing}).then(()=>{if(!playing)window.dispatchEvent(new Event("hpp.playback.idle"));}).catch(()=>{});
    const fail=()=>{if(!disposed&&!failed){failed=true;reportMediaError(v,p.media);latest.current.onError();}};
    const metadata=()=>{if(p.position>0&&Number.isFinite(v.duration))v.currentTime=Math.min(p.position,Math.max(0,v.duration-.15));if(latest.current.active&&wantsPlay.current)play();};
    const playing=()=>{if(!disposed){activity(true);latest.current.onPlaying();}};
    const paused=()=>{if(!disposed&&v.paused){activity(false);latest.current.onTime(v.currentTime);if(!v.ended){if(wantsPlay.current&&latest.current.active&&v.readyState<3)latest.current.onWaiting();else latest.current.onPause();}}};
    const visibility=()=>{if(document.hidden){resume=!v.paused;v.pause();hls.current?.stopLoad();}else if(resume){resume=false;if(latest.current.active){hls.current?.startLoad(v.currentTime);play();}}};
    // 原来由 JSX 上的 onXxx 绑定；元素现在是共享的、不归 React 管，改成随会话挂载/摘除的原生监听
    const dimensions=()=>{if(Number.isFinite(v.duration))latest.current.onDuration(v.duration);if(v.videoWidth)latest.current.onSize(v.videoWidth,v.videoHeight);};
    const timeupdate=()=>{latest.current.onTime(v.currentTime);buffered(v);};
    const onPlayEv=()=>{if(!v.paused){wantsPlay.current=true;latest.current.onWaiting();}};
    const onWaitingEv=()=>{if(!v.paused)latest.current.onWaiting();};
    const onSeekedEv=()=>{if(!v.paused&&v.readyState>=3)latest.current.onPlaying();};
    const onEndedEv=()=>latest.current.onEnded?.();
    const onProgressEv=()=>buffered(v);
    const evs:[string,EventListener][]=[["loadedmetadata",dimensions],["loadeddata",dimensions],["timeupdate",timeupdate],["progress",onProgressEv],["play",onPlayEv],["waiting",onWaitingEv],["seeking",onWaitingEv],["seeked",onSeekedEv],["ended",onEndedEv]];
    for(const [n,f] of evs)v.addEventListener(n,f);
    v.muted=p.muted;v.volume=p.volume;v.playbackRate=p.rate;
    v.autoplay=!!(p.autoPlay&&p.active);
    // 上一条留下的字幕轨/海报要先清；字幕随 media 变
    v.querySelectorAll("track").forEach(t=>t.remove());
    for(const [i,t] of (p.media.playback.subtitles||[]).filter(t=>t.format==="vtt").entries()){
      const tr=document.createElement("track");tr.kind="subtitles";tr.src=t.url;tr.label=t.label||t.language||`字幕 ${i+1}`;if(t.language)tr.srclang=t.language;tr.default=!!t.default;v.appendChild(tr);
    }
    if(p.poster)v.poster=p.poster;else v.removeAttribute("poster");
    v.addEventListener("loadedmetadata",metadata);v.addEventListener("error",fail);v.addEventListener("playing",playing);v.addEventListener("pause",paused);document.addEventListener("visibilitychange",visibility);
    if(p.media.format==="hls"&&hlsPlaybackPath(v)==="mse"){
      const engine=new Hls({enableWorker:true,workerPath,autoStartLoad:p.active&&!document.hidden,startPosition:Math.max(0,p.position),backBufferLength:30,interstitialsController:undefined,contentSteeringController:undefined,enableInterstitialPlayback:false});
      hls.current=engine;engine.loadSource(p.media.url);engine.attachMedia(v);
      engine.on(Hls.Events.ERROR,(_,data)=>{if(data.fatal)fail();});
    }else v.src=p.media.url;
    playbackTiming(p.media.sessionId,'media-load');
    if(v.requestVideoFrameCallback)firstFrame=v.requestVideoFrameCallback(()=>{if(!disposed){playbackTiming(p.media.sessionId,'first-frame',started);if(p.media.requestedAt!==undefined)playbackTiming(p.media.sessionId,'intent-to-first-frame',p.media.requestedAt);}});
    const expiry=p.media.playback.expiresAt;
    const timer=expiry?window.setTimeout(fail,Math.max(1000,Math.min(2_147_483_647,expiry-Date.now()-5000))):undefined;
    return()=>{
      disposed=true;playAttempt.current++;if(firstFrame!==undefined)v.cancelVideoFrameCallback(firstFrame);clearTimeout(timer);activity(false);
      document.removeEventListener("visibilitychange",visibility);v.removeEventListener("loadedmetadata",metadata);v.removeEventListener("error",fail);v.removeEventListener("playing",playing);v.removeEventListener("pause",paused);
      for(const [n,f] of evs)v.removeEventListener(n,f);
      hls.current?.destroy();hls.current=null;
      // 元素已被下一个会话接管时，不能再清空它的 src，否则会把刚设好的新视频掐掉
      if(owner===me){v.pause();v.removeAttribute("src");v.querySelectorAll("track").forEach(t=>t.remove());v.load();owner=null;}
    };
  },[props.media.sessionId,props.media.version]);
  /* 变换/适配跟着 props 走（原来是 JSX style，现在元素不归 React，手动同步） */
  useEffect(()=>{const v=ref.current;if(!v)return;v.style.objectFit=props.fit;v.style.transform=`translate(${props.panX}px, ${props.panY}px) scale(${props.scale})`;v.style.transition=props.isGesturing?"none":"transform .18s ease";},[props.fit,props.panX,props.panY,props.scale,props.isGesturing]);
  useEffect(()=>{const v=ref.current;if(v){v.muted=props.muted;v.volume=props.volume;v.playbackRate=props.rate;}},[props.muted,props.volume,props.rate]);
  useEffect(()=>{if(!props.active||document.hidden){ref.current?.pause();hls.current?.stopLoad();}else if(hls.current)hls.current.startLoad(ref.current?.currentTime||props.position);},[props.active,props.media.sessionId,props.media.version]);
  const buffered=(v:HTMLVideoElement)=>{const f=latest.current;f.onBuffered(v.duration&&v.buffered.length?v.buffered.end(v.buffered.length-1)/v.duration:0);let ahead=0;for(let i=0;i<v.buffered.length;i++)if(v.buffered.start(i)<=v.currentTime+.1&&v.buffered.end(i)>v.currentTime)ahead=v.buffered.end(i)-v.currentTime;f.onBuffer?.(ahead);};
  return <div ref={hostRef} className="absolute inset-0 overflow-hidden" onClick={props.onClick}/>;
});
