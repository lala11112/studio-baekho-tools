/** Verified against installed URP 17.3.0 UniversalRenderPipeline.Render setter. */
export type UnityTargetProfilePolicy = {schemaVersion:1;kind:'urp-linear-intensity-v1';urpVersion:'17.3.0';activeColorSpace:'gamma'|'linear';playerSettingsSha256:string};
export function serializedUnityColorSpace(text:string):'gamma'|'linear'|undefined {
  const fields=text.match(/^[ \t]*m_ActiveColorSpace:[^\n]*$/gm)??[];
  if(fields.length!==1)return;
  const value=fields[0].match(/^[ \t]*m_ActiveColorSpace:[ \t]*([01])[ \t]*\r?$/)?.[1];
  return value==='0'?'gamma':value==='1'?'linear':undefined;
}
export function validUnityTargetProfilePolicy(value:unknown):value is UnityTargetProfilePolicy {
  const p=value as UnityTargetProfilePolicy;
  return !!p&&Object.keys(p).length===5&&p.schemaVersion===1&&p.kind==='urp-linear-intensity-v1'&&p.urpVersion==='17.3.0'&&(p.activeColorSpace==='gamma'||p.activeColorSpace==='linear')&&typeof p.playerSettingsSha256==='string'&&/^[a-f\d]{64}$/.test(p.playerSettingsSha256);
}
/** Preserve every byte represented by UTF-8 text, including BOM/CRLF, except one derived digit. */
export function normalizeUnityLinearIntensity(text:string,colorSpace:'gamma'|'linear'):string|undefined {
  const fields=text.match(/^[ \t]*m_LightsUseLinearIntensity:[^\n]*$/gm)??[];
  if(fields.length!==1||!fields[0].match(/^[ \t]*m_LightsUseLinearIntensity:[ \t]*[01][ \t]*\r?$/))return;
  return text.replace(/^([ \t]*m_LightsUseLinearIntensity:[ \t]*)[01]([ \t]*\r?)$/m,(_,prefix,suffix)=>prefix+(colorSpace==='linear'?'1':'0')+suffix);
}
export function unityTargetProfileMatches(current:{fingerprint:string;legacyRawFingerprint?:string},expected:{fingerprint:string;fingerprintVersion?:2}):boolean {
  return expected.fingerprintVersion===2?current.fingerprint===expected.fingerprint:expected.fingerprintVersion===undefined&&current.legacyRawFingerprint===expected.fingerprint;
}
/** Host-generated request field names are literal; reject duplicate/escaped aliases before JSON loses them. */
export function parseUnityProfileRequest(raw:string):any {
  const text=raw.replace(/^\uFEFF/,''),value=JSON.parse(text),stack:(Set<string>|null)[]=[];
  for(let i=0;i<text.length;i++){
    const c=text[i];if(c==='"'){
      const start=i;for(i++;i<text.length;i++){if(text[i]==='\\'){i++;continue;}if(text[i]==='"')break;}
      let after=i+1;while(/\s/.test(text[after]??'')&&after<text.length)after++;
      if(text[after]===':'&&stack.at(-1)){
        const literal=text.slice(start,i+1);if(literal.includes('\\'))throw Error('고정 대상 요청의 이스케이프 필드 이름은 지원하지 않습니다.');
        const key=JSON.parse(literal);if(stack.at(-1)!.has(key))throw Error('고정 대상 요청에 중복 필드가 있습니다.');stack.at(-1)!.add(key);
      }
    }else if(c==='{')stack.push(new Set());else if(c==='[')stack.push(null);else if(c==='}'||c===']')stack.pop();
  }
  if(value.profileFingerprintVersion!==undefined&&value.profileFingerprintVersion!==2)throw Error('지원하지 않는 대상 프로필 버전입니다.');
  if(value.profilePolicy!==undefined&&!validUnityTargetProfilePolicy(value.profilePolicy))throw Error('고정 대상 정책이 불완전합니다.');
  for(const f of value.profileFiles??[]){if(f.normalizedSha256!==undefined&&(typeof f.normalizedSha256!=='string'||!/^[a-f\d]{64}$/.test(f.normalizedSha256))||f.absent!==undefined&&typeof f.absent!=='boolean')throw Error('고정 대상 파일 정책이 불완전합니다.');}
  return value;
}
