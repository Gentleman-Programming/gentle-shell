/** Descriptive registry metadata, never authorization or a callable reviewer tool. */
export interface AutoPermissionToolContext {
 name: string;
 description: string;
 parameters: Record<string, unknown> | boolean;
}
const MAX_BYTES = 8192;
/** Snapshot plain schema data without invoking getters/serializers. Drop unusable metadata whole. */
export function projectToolContext(value: unknown, name: string, unsafeText: (text:string)=>boolean = ()=>false): AutoPermissionToolContext | undefined {
 try {
  let nodes=0, bytes=0;
  const text=(s:string)=>{
   bytes+=Buffer.byteLength(s);
   if(bytes>MAX_BYTES || /[\p{Cf}\p{Cs}]/u.test(s) || unsafeText(s))throw Error("unusable-metadata");
   return s;
  };
  const json=(input:unknown,depth=0,declarations=false,propertyName?:string):unknown=>{
   if(++nodes>512 || depth>12)throw Error("unusable-metadata");
   if(typeof input==="string")return text(input);
   if(input===null || typeof input==="boolean" || (typeof input==="number" && Number.isFinite(input)))return input;
   if(!input || typeof input!=="object")throw Error("unusable-metadata");
   const array=Array.isArray(input), proto=Object.getPrototypeOf(input);
   if(array ? proto!==Array.prototype : proto!==Object.prototype && proto!==null)throw Error("unusable-metadata");
   const descriptors=Object.getOwnPropertyDescriptors(input);
   const entries:[string,unknown][]=[];
   for(const key of Object.keys(descriptors)) {
    if(array && key==="length")continue;
    const descriptor=descriptors[key];
    if(!descriptor.enumerable)continue; // TypeBox also carries non-enumerable string annotations.
    if(!Object.hasOwn(descriptor,"value") || key==="toJSON")throw Error("unusable-metadata");
    if(array && !/^(0|[1-9][0-9]*)$/.test(key))throw Error("unusable-metadata");
    const child=json(descriptor.value,depth+1,key==="properties" || key==="patternProperties",declarations ? key : propertyName);
    // Property declarations describe slots; examples/defaults/const/enum contain values.
    const literal=["examples","example","default","const","enum"].includes(key);
    const assignment=(field:string)=>child!==null && child!=="" && unsafeText(`${field}=${typeof child==="number" ? child : "value"}`);
    if((!declarations && assignment(key)) || (literal &&
     (unsafeText(JSON.stringify(child)) || (propertyName!==undefined && assignment(propertyName)))))throw Error("unusable-metadata");
    entries.push([text(key),child]);
   }
   // TypeBox's symbol annotations are not JSON Schema and are not sent to the reviewer.
   if(array) {
    if(descriptors.length.value!==entries.length)throw Error("unusable-metadata");
    return entries.map(([,item])=>item);
   }
   return Object.fromEntries(entries);
  };
  if(!value || typeof value!=="object")return undefined;
  const descriptors=Object.getOwnPropertyDescriptors(value);
  const field=(key:string)=>{
   const descriptor=descriptors[key];
   if(!descriptor || !Object.hasOwn(descriptor,"value"))throw Error("unusable-metadata");
   return descriptor.value;
  };
  const toolName=field("name"), description=field("description"), parameters=json(field("parameters"));
  if(toolName!==name || typeof toolName!=="string" || !name || name.length>256 || typeof description!=="string" ||
   !(typeof parameters==="boolean" || (parameters!==null && typeof parameters==="object" && !Array.isArray(parameters))))return undefined;
  const result={name:text(toolName),description:text(description),parameters} as AutoPermissionToolContext;
  if(Buffer.byteLength(JSON.stringify(result))>MAX_BYTES)return undefined;
  return result;
 } catch { return undefined; }
}
