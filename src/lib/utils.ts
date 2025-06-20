import { audio, settingsContainer, title } from "./dom";
import { getThumbIdFromLink } from "./imageUtils";
import player from "./player";
import { state, store } from "./store";
import fetchList from "../modules/fetchList";
import { fetchCollection, removeFromCollection } from "./libraryUtils";
import { i18n } from "../scripts/i18n.ts";


export const goTo = (route: Routes | 'history' | 'discover') => (<HTMLAnchorElement>document.getElementById(route)).click();

export const idFromURL = (link: string | null) => link?.match(/(https?:\/\/)?((www\.)?(youtube(-nocookie)?|youtube.googleapis)\.com.*(v\/|v=|vi=|vi\/|e\/|embed\/|user\/.*\/u\/\d+\/)|youtu\.be\/)([_0-9a-z-]+)/i)?.[7];

export const getApi = (
  type: 'piped' | 'invidious',
  index: number = store.api.index
) =>
  type === 'piped' ?
    store.api.piped.concat(store.player.hls.api)[index] :
    store.api.invidious[index];

const pathModifier = (url: string) => url.includes('=') ?
  'playlists=' + url.split('=')[1] :
  url.slice(1).split('/').join('=');

export const hostResolver = (url: string) =>
  store.linkHost + (store.linkHost.includes(location.origin) ? (url.
    startsWith('/watch') ?
    ('?s' + url.slice(8)) :
    ('/list?' + pathModifier(url))) : url);


export function proxyHandler(url: string, prefetch: boolean = false) {
  store.api.index = 0;
  if (!prefetch)
    title.textContent = i18n('player_audiostreams_insert');
  const link = new URL(url);
  const origin = link.origin.slice(8);
  const host = link.searchParams.get('host');

  return state.enforceProxy ?
    (url + (host ? '' : `&host=${origin}`)) :
    (host && !state.customInstance) ? url.replace(origin, host) : url;
}

export async function quickSwitch() {
  if (!store.stream.id) return;
  if (store.player.playbackState === 'playing')
    audio.pause();
  const timeOfSwitch = audio.currentTime;
  await player(store.stream.id);
  audio.currentTime = timeOfSwitch;
  audio.play();
}


export async function preferredStream(audioStreams: AudioStream[]) {
  const preferedCodec: 'opus' | 'aac' = state.codec === 'any' ? ((await store.player.supportsOpus) ? 'opus' : 'aac') : state.codec;
  const itags = ({
    low: {
      opus: [600, 249, 251],
      aac: [599, 139, 140]
    },
    medium: {
      opus: [250, 249, 251],
      aac: [139, 140]
    },
    high: {
      opus: [251],
      aac: [140]
    }
  })[state.quality || 'medium'][preferedCodec];
  let stream!: AudioStream;
  for (const itag of itags) {
    if (stream?.url) continue;
    const v = audioStreams.find(v => v.url.includes(`itag=${itag}`));
    if (v) stream = v;
  }

  return stream;
}


export function notify(text: string) {
  const el = document.createElement('p');
  const clear = () => el.isConnected && el.remove();
  el.className = 'snackbar';
  el.textContent = text;
  el.onclick = clear;
  setTimeout(clear, 8e3);
  if (settingsContainer.open) {
    const settingsHeader = settingsContainer.firstElementChild as HTMLHeadingElement;
    settingsHeader.appendChild(el);
  } else
    document.body.appendChild(el);
}


export function convertSStoHHMMSS(seconds: number): string {
  if (seconds < 0) return '';
  if (seconds === Infinity) return 'Emergency Mode';
  const hh = Math.floor(seconds / 3600);
  seconds %= 3600;
  const mm = Math.floor(seconds / 60);
  const ss = Math.floor(seconds % 60);
  let mmStr = String(mm);
  let ssStr = String(ss);
  if (mm < 10) mmStr = '0' + mmStr;
  if (ss < 10) ssStr = '0' + ssStr;
  return (hh > 0 ?
    hh + ':' : '') + `${mmStr}:${ssStr}`;
}

export function handleXtags(audioStreams: AudioStream[]) {
  const isDRC = (url: string) => url.includes('drc%3D1');
  const useDRC = state.stableVolume && Boolean(audioStreams.find(a => isDRC(a.url)));
  const isOriginal = (a: { url: string }) => !a.url.includes('acont%3Ddubbed');

  return audioStreams
    .filter(a => useDRC ? isDRC(a.url) : !isDRC(a.url))
    .filter(isOriginal);
}

export async function getDownloadLink(id: string): Promise<string | null> {
  const streamUrl = 'https://youtu.be/' + id;
  
  // Array of working Cobalt API endpoints (ordered by reliability and preference)
  // Based on https://instances.cobalt.best/ and testing results
  const cobaltApis = [
    // Official cobalt.tools instances (highest reliability)
    'https://sunny.imput.net',
    'https://nachos.imput.net', 
    'https://kityune.imput.net',
    'https://blossom.imput.net',
    
    // High-scoring community instances
    'https://cobalt-backend.canine.tools',
    'https://capi.3kh0.net',
    
    // Additional working instances
    'https://noodle.imput.net',
    'https://cobalt.api.timelessnesses.me',
    'https://olly.imput.net',
    
    // Lower score but potentially working instances
    'https://downloadapi.stuff.solutions',
    'https://cobalt-7.kwiatekmiki.com'
  ];

  const requestBody = {
    url: streamUrl,
    downloadMode: 'audio',
    audioFormat: store.downloadFormat,
    filenameStyle: 'basic'
  };

  let lastError = '';

  // Try each API endpoint until one works
  for (let i = 0; i < cobaltApis.length; i++) {
    const apiUrl = cobaltApis[i];
    
    try {
      console.log(`Attempting download from API ${i + 1}/${cobaltApis.length}: ${apiUrl}`);
      
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: { 
          'Accept': 'application/json', 
          'Content-Type': 'application/json',
          'User-Agent': 'Ytify-App/1.0'
        },
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(10000) // 10 second timeout
      });

      if (!response.ok) {
        console.warn(`API ${apiUrl} returned status ${response.status}`);
        lastError = `HTTP ${response.status}`;
        continue;
      }

      const data = await response.json();
      
      // Check for successful response with download URL
      if ('url' in data && data.url && typeof data.url === 'string') {
        const downloadUrl = data.url;
        console.log(`Got potential download URL from ${apiUrl}: ${downloadUrl}`);
        
        // Strict validation of the download URL
        try {
          // Check if URL is valid and accessible
          const testResponse = await fetch(downloadUrl, { 
            method: 'HEAD',
            signal: AbortSignal.timeout(5000) // 5 second timeout for verification
          });
          
          if (!testResponse.ok) {
            console.warn(`Download URL from ${apiUrl} returned ${testResponse.status}`);
            lastError = `Download URL returned ${testResponse.status}`;
            continue;
          }
          
          // Check content length
          const contentLength = testResponse.headers.get('content-length');
          if (contentLength && parseInt(contentLength) === 0) {
            console.warn(`Download URL from ${apiUrl} has 0 bytes content`);
            lastError = 'Download URL has 0 bytes';
            continue;
          }
          
          // Check if content-length is missing but content-type suggests it should have content
          const contentType = testResponse.headers.get('content-type');
          if (!contentLength && contentType && (
            contentType.includes('audio/') || 
            contentType.includes('video/') ||
            contentType.includes('application/octet-stream')
          )) {
            // For streaming content without explicit length, this might be okay
            console.log(`Download URL from ${apiUrl} has streaming content type: ${contentType}`);
          } else if (!contentLength) {
            console.warn(`Download URL from ${apiUrl} has no content-length header and unclear content-type`);
            lastError = 'Download URL has unclear content';
            continue;
          }
          
          console.log(`✅ Successfully validated download URL from ${apiUrl}`);
          return downloadUrl;
          
        } catch (testError) {
          console.warn(`Failed to verify download URL from ${apiUrl}:`, testError);
          lastError = `URL verification failed: ${testError}`;
          continue;
        }
        
      } else if ('error' in data && data.error) {
        const errorMsg = typeof data.error === 'string' ? data.error : 
                        (data.error.code || JSON.stringify(data.error));
        console.warn(`API ${apiUrl} returned error:`, errorMsg);
        lastError = errorMsg;
        continue;
        
      } else {
        console.warn(`API ${apiUrl} returned unexpected response format:`, data);
        lastError = 'Unexpected response format';
        continue;
      }
      
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.warn(`Failed to fetch from ${apiUrl}:`, errorMsg);
      lastError = errorMsg;
      continue;
    }
  }

  // If we get here, all APIs failed
  const errorMessage = `Download failed: ${lastError || 'All download services are unavailable'}. Please try again later.`;
  notify(errorMessage);
  console.error('All Cobalt API endpoints failed. Last error:', lastError);
  return null;
}

export async function errorHandler(
  message: string = '',
  redoAction: () => void,
) {

  if (message === 'nextpage error') return;

  if (
    message !== 'No Data Found' &&
    store.api.index < store.api.piped.length - 1
  ) {
    store.api.index++;
    return redoAction();
  }
  notify(message);
  store.api.index = 0;
}


// TLDR : Stream Item Click Action
export async function superClick(e: Event) {
  const elem = e.target as HTMLAnchorElement & { dataset: CollectionItem };
  if (elem.target === '_blank') return;
  e.preventDefault();

  const eld = elem.dataset;
  const elc = elem.classList.contains.bind(elem.classList);

  if (elc('streamItem'))
    return elc('delete') ?
      removeFromCollection(store.list.id, eld.id as string)
      : player(eld.id);

  else if (elc('clxn_item'))
    fetchCollection(elem.href.split('=')[1]);


  else if (elc('ri-more-2-fill')) {
    const elp = elem.parentElement!.dataset;
    const sta = store.actionsMenu;
    sta.id = elp.id as string;
    sta.title = elp.title as string;
    sta.author = elp.author as string;
    sta.channelUrl = elp.channel_url as string;
    sta.duration = elp.duration as string;
    const dialog = document.createElement('dialog');
    document.body.appendChild(dialog);
    import('../components/ActionsMenu.ts')
      .then(mod => mod.default(dialog));


  }


  else if (elc('listItem')) {

    // to prevent conflicts
    store.actionsMenu.author = '';

    let url = eld.url as string;

    if (!url.startsWith('/channel'))
      url = url.replace('?list=', 's/');

    store.list.name = (
      (location.search.endsWith('music_artists') ||
        (location.pathname === '/library' && state.defaultSuperCollection === 'artists')
      )
        ? 'Artist - ' : ''
    ) + eld.title;
    store.list.uploader = eld.uploader!;

    store.list.thumbnail = eld.thumbnail ? getThumbIdFromLink(eld.thumbnail) : '';

    fetchList(url);
  }
}

