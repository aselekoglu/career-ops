"use client";
import { useState } from "react";
import type { FormEvent } from "react";
import { ArrowDownToLine, FolderArchive, Link2, LockKeyhole, Plus, RefreshCw, UploadCloud } from "lucide-react";

type Project={id:string;name:string;summary:string;url:string;tags:string[]};
type Version={version:number;bytes:number;sha256:string;createdAt:string};
type Portfolio={id:string;title:string;kind:"master"|"variant";tags:string[];projectIds:string[];versions:Version[];latestVersion:number|null};
type Assoc={applicationNumber:string;portfolioId:string;version:number};
type Library={portfolios:Portfolio[];projects:Project[];associations:Assoc[]};
type Recommendation={portfolioId:string;matchedTerms:string[];score:number};

const words=(value:string)=>[...new Set(value.split(",").map(v=>v.trim().toLowerCase()).filter(Boolean))];
const label=(v:string)=>v.replace(/^PORTFOLIO_/,"").replace(/_/g," ").toLowerCase();

export function PortfolioView(){
  const [secret,setSecret]=useState("");
  const [connected,setConnected]=useState(false);
  const [catalog,setCatalog]=useState<Library>({portfolios:[],projects:[],associations:[]});
  const [busy,setBusy]=useState("");
  const [error,setError]=useState("");
  const [success,setSuccess]=useState("");
  const [title,setTitle]=useState("");
  const [kind,setKind]=useState<"master"|"variant">("master");
  const [tags,setTags]=useState("business analyst, automation, systems integration");
  const [file,setFile]=useState<File|null>(null);
  const [projectIds,setProjectIds]=useState<string[]>([]);
  const [projectName,setProjectName]=useState("");
  const [projectSummary,setProjectSummary]=useState("");
  const [projectUrl,setProjectUrl]=useState("");
  const [projectTags,setProjectTags]=useState("");
  const [appNumber,setAppNumber]=useState("");
  const [role,setRole]=useState("");
  const [recommendations,setRecommendations]=useState<Recommendation[]>([]);
  const [versions,setVersions]=useState<Record<string,number>>({});

  async function api<T>(route:string,init?:RequestInit):Promise<T>{
    const r=await fetch(route,{cache:"no-store",...init,headers:{"X-Career-Ops-Portfolio-Token":secret,...(init?.headers||{})}});
    const mime=r.headers.get("content-type")||"";
    const payload=mime.includes("application/json")?await r.json():null;
    if(!r.ok) throw new Error(label(payload?.code||"REQUEST_FAILED"));
    return payload as T;
  }
  async function refresh(){
    const lib=await api<Library>("/api/portfolio");
    setCatalog(lib);setConnected(true);return lib;
  }
  async function run(key:string,fn:()=>Promise<void>){
    setBusy(key);setError("");setSuccess("");
    try{await fn();}catch(e){setError(e instanceof Error?e.message:"Operation failed");}
    finally{setBusy("");}
  }
  const upload=async(e:FormEvent<HTMLFormElement>)=>{
    e.preventDefault();
    const form=e.currentTarget;
    await run("upload",async()=>{
      if(!file) throw new Error("Select a PDF file");
      const payload=new FormData();
      payload.set("file",file);payload.set("title",title);payload.set("kind",kind);
      payload.set("tags",JSON.stringify(words(tags)));payload.set("projectIds",JSON.stringify(projectIds));
      await api("/api/portfolio",{method:"POST",body:payload});
      await refresh();setFile(null);setTitle("");form.reset();
      setSuccess("Portfolio saved in the existing Neon document store.");
    });
  };
  const addProject=async(e:FormEvent<HTMLFormElement>)=>{
    e.preventDefault();
    await run("project",async()=>{
      await api("/api/portfolio/projects",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({
        name:projectName,summary:projectSummary,url:projectUrl,tags:words(projectTags)
      })});
      await refresh();setProjectName("");setProjectSummary("");setProjectUrl("");setProjectTags("");
      setSuccess("Project added to the registry.");
    });
  };
  const addVersion=(p:Portfolio,newFile:File|undefined)=>{
    if(!newFile)return;
    void run("version-"+p.id,async()=>{
      const payload=new FormData();payload.set("portfolioId",p.id);payload.set("file",newFile);
      await api("/api/portfolio",{method:"POST",body:payload});
      await refresh();setSuccess("Archived a new immutable version of "+p.title+".");
    });
  };
  const download=(p:Portfolio,v:number)=>void run("download-"+p.id,async()=>{
    const res=await fetch("/api/portfolio/pdf?portfolioId="+encodeURIComponent(p.id)+"&version="+v,{
      headers:{"X-Career-Ops-Portfolio-Token":secret},cache:"no-store"
    });
    if(!res.ok){
      let code="DOWNLOAD_FAILED";try{code=(await res.json()).code||code;}catch{/* ignore */}
      throw new Error(label(code));
    }
    const blob=await res.blob();const url=URL.createObjectURL(blob);
    const a=document.createElement("a");a.href=url;a.download=(p.title.replace(/[^\w-]+/g,"-")||"portfolio")+"-v"+v+".pdf";
    document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),30_000);
  });
  const recommend=()=>void run("recommend",async()=>{
    const result=await api<{application:{role:string},recommendations:Recommendation[]}>(
      "/api/portfolio/recommend?applicationNumber="+encodeURIComponent(appNumber.trim()));
    setRole(result.application.role);setRecommendations(result.recommendations);
  });
  const attach=(p:Portfolio)=>void run("attach-"+p.id,async()=>{
    const version=versions[p.id]||p.latestVersion;
    if(!version)throw new Error("Portfolio has no versions");
    await api("/api/portfolio/associate",{method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({applicationNumber:appNumber.trim(),portfolioId:p.id,version})});
    await refresh();setSuccess("Attached "+p.title+" v"+version+" to application #"+appNumber+". No application was submitted.");
  });

  const box="rounded-2xl border border-border bg-surface p-5 shadow-sm";
  const input="w-full rounded-xl border border-border bg-background px-3 py-2.5 text-sm text-foreground outline-none focus:border-brand";
  const primary="inline-flex items-center justify-center gap-2 rounded-full bg-brand px-5 py-2.5 text-sm font-semibold text-brand-foreground hover:bg-brand-200 disabled:opacity-50";
  const muted="inline-flex items-center justify-center gap-2 rounded-full border border-border bg-surface px-4 py-2 text-sm hover:bg-surface-hover disabled:opacity-50";
  const blocked=Boolean(busy);
  return <main className="mx-auto max-w-6xl space-y-8 px-5 py-8 md:px-8">
    <header className="border-b border-border pb-6">
      <span className="font-mono text-[11px] uppercase tracking-[.2em] text-brand-text">Supporting documents / private</span>
      <h1 className="mt-3 font-display text-4xl tracking-tight text-landing md:text-5xl">Portfolio library<span className="text-brand-text">.</span></h1>
      <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted">
        Reuse master PDFs and role-specific variants across applications. Files live in the same Neon document store as your tailored CVs.
        Recommendations are advisory; attaching a portfolio requires your approval.
      </p>
    </header>

    <section className={box}>
      <div className="flex items-center gap-2"><LockKeyhole size={18} className="text-brand-text"/><h2 className="font-medium">Owner access</h2></div>
      <p className="mt-2 text-xs text-muted">Enter the separately configured portfolio access token. Held in this page's memory only; never added to URLs, cookies or local storage.</p>
      <div className="mt-4 flex flex-wrap gap-2"><input aria-label="Portfolio access token" type="password" autoComplete="off"
        className={input+" max-w-md flex-1"} value={secret} onChange={e=>{setSecret(e.target.value);setConnected(false);}} placeholder="Portfolio access token"/>
        <button type="button" disabled={blocked||!secret} className={primary} onClick={()=>void run("connect",async()=>{await refresh();setSuccess("Connected to your private portfolio library.");})}>
          {busy==="connect"?"Connecting…":"Unlock library"}</button>
        {connected&&<button type="button" disabled={blocked} className={muted} onClick={()=>void run("refresh",async()=>{await refresh();})}><RefreshCw size={15}/>Refresh</button>}
      </div>
      {error&&<p role="alert" className="mt-3 rounded-lg bg-red-500/10 p-3 text-sm text-red-600 dark:text-red-400">{error}</p>}
      {success&&<p role="status" className="mt-3 rounded-lg bg-brand-soft p-3 text-sm text-brand-text">{success}</p>}
    </section>

    {connected&&<>
      <div className="grid gap-6 lg:grid-cols-2">
        <form className={box+" space-y-3"} onSubmit={upload}>
          <div className="flex items-center gap-2"><UploadCloud size={19} className="text-brand-text"/><h2 className="text-lg font-semibold">Import a PDF</h2></div>
          <p className="text-xs text-muted">Keep your Brookfield document as a variant; upload a reusable master separately. PDF limit: 4 MB.</p>
          <input required maxLength={160} value={title} onChange={e=>setTitle(e.target.value)} placeholder="Portfolio title" className={input}/>
          <div className="flex items-center gap-4 text-sm">
            <label className="flex items-center gap-2"><input type="radio" checked={kind==="master"} onChange={()=>setKind("master")}/>Master</label>
            <label className="flex items-center gap-2"><input type="radio" checked={kind==="variant"} onChange={()=>setKind("variant")}/>Role-focused variant</label>
          </div>
          <input value={tags} onChange={e=>setTags(e.target.value)} placeholder="Tags, comma separated" className={input}/>
          <input required type="file" accept="application/pdf,.pdf" className="block w-full text-sm file:mr-4 file:rounded-full file:border-0 file:bg-brand-soft file:px-3 file:py-2 file:text-brand-text" onChange={e=>setFile(e.target.files?.[0]||null)}/>
          {catalog.projects.length>0&&<fieldset className="space-y-1"><legend className="mb-1 text-xs text-muted">Included projects (optional)</legend>
            <div className="flex max-h-28 flex-wrap gap-3 overflow-y-auto">{catalog.projects.map(p=><label key={p.id} className="flex items-center gap-1 text-xs">
              <input type="checkbox" checked={projectIds.includes(p.id)} onChange={e=>setProjectIds(old=>e.target.checked?[...old,p.id]:old.filter(id=>id!==p.id))}/>{p.name}
            </label>)}</div>
          </fieldset>}
          <button disabled={blocked} className={primary} type="submit"><Plus size={16}/>{busy==="upload"?"Saving…":"Archive portfolio"}</button>
        </form>

        <form className={box+" space-y-3"} onSubmit={addProject}>
          <h2 className="flex items-center gap-2 text-lg font-semibold"><FolderArchive size={19} className="text-brand-text"/> Project registry</h2>
          <p className="text-xs text-muted">Describe only projects and contributions you can substantiate. Registry entries link to evidence rather than inventing achievements.</p>
          <input required className={input} placeholder="Project name" value={projectName} onChange={e=>setProjectName(e.target.value)}/>
          <textarea required className={input} rows={2} placeholder="Your contribution and technical outcome" value={projectSummary} onChange={e=>setProjectSummary(e.target.value)}/>
          <input className={input} type="url" placeholder="https://github.com/… (optional)" value={projectUrl} onChange={e=>setProjectUrl(e.target.value)}/>
          <input className={input} placeholder="Project tags (optional)" value={projectTags} onChange={e=>setProjectTags(e.target.value)}/>
          <button disabled={blocked} type="submit" className={muted}><Plus size={16}/>Add project</button>
          {catalog.projects.length>0&&<p className="pt-1 text-xs text-muted">{catalog.projects.length} projects indexed · HTTPS evidence links supported</p>}
        </form>
      </div>

      <section className={box+" space-y-3"}>
        <h2 className="flex items-center gap-2 text-lg font-semibold"><Link2 size={18} className="text-brand-text"/>Match to an application</h2>
        <p className="text-xs text-muted">Enter a real Career Ops tracker number. The suggestion score is simple role-tag overlap—not a model-generated fit rating. Nothing is attached until you click Attach.</p>
        <div className="flex flex-wrap gap-2"><input className={input+" max-w-xs"} aria-label="Application number" inputMode="numeric"
          value={appNumber} onChange={e=>{setAppNumber(e.target.value);setRecommendations([]);setRole("");}} placeholder="Application # (e.g. 54)"/>
          <button type="button" className={muted} disabled={blocked||!appNumber.trim()} onClick={recommend}>Find relevant portfolios</button></div>
        {role&&<p className="text-sm text-muted">Matching against: <strong className="text-foreground">{role}</strong></p>}
        {catalog.associations.filter(a=>a.applicationNumber===appNumber.trim()).map(a=><p key={a.applicationNumber} className="text-xs text-brand-text">
          Linked: {catalog.portfolios.find(p=>p.id===a.portfolioId)?.title||a.portfolioId} · version {a.version}</p>)}
      </section>

      <section className="space-y-4">
        <div className="flex items-center justify-between"><h2 className="font-display text-2xl text-landing">Saved portfolios</h2>
          <span className="font-mono text-xs text-faint">{catalog.portfolios.length} archives</span></div>
        {catalog.portfolios.length===0&&<div className={box+" text-sm text-muted"}>No portfolios yet. Import your existing Brookfield PDF above to create your first entry.</div>}
        <div className="grid gap-4 md:grid-cols-2">
          {catalog.portfolios.slice().sort((a,b)=>(recommendations.find(x=>x.portfolioId===b.id)?.score||0)-(recommendations.find(x=>x.portfolioId===a.id)?.score||0)).map(p=>{
            const chosen=versions[p.id]||p.latestVersion||1;
            const suggestion=recommendations.find(r=>r.portfolioId===p.id);
            return <article key={p.id} className={box+" space-y-3"}>
              <div className="flex items-start justify-between gap-3">
                <div><span className="font-mono text-[10px] uppercase tracking-[.18em] text-brand-text">{p.kind} / {p.versions.length} versions</span>
                  <h3 className="mt-1 text-lg font-semibold">{p.title}</h3></div>
                {suggestion&&<span className="rounded-full bg-brand-soft px-2 py-1 text-xs text-brand-text">{suggestion.score} matching terms</span>}
              </div>
              <p className="text-xs text-muted">{p.tags.join(" · ")||"No tags"}</p>
              {suggestion&&suggestion.matchedTerms.length>0&&<p className="text-xs text-brand-text">Matched: {suggestion.matchedTerms.join(", ")}</p>}
              <label className="flex flex-wrap items-center gap-2 text-sm">Version
                <select className={input+" max-w-32"} value={chosen} onChange={e=>setVersions(old=>({...old,[p.id]:Number(e.target.value)}))}>
                  {p.versions.map(v=><option key={v.version} value={v.version}>v{v.version}</option>)}
                </select></label>
              <div className="flex flex-wrap gap-2">
                <button disabled={blocked} type="button" className={muted} onClick={()=>download(p,chosen)}><ArrowDownToLine size={15}/>PDF</button>
                {role&&<button disabled={blocked} type="button" className={primary} onClick={()=>attach(p)}><Link2 size={15}/>Attach to #{appNumber}</button>}
                <label className={muted+" cursor-pointer"}><UploadCloud size={15}/>New version
                  <input className="sr-only" type="file" accept=".pdf,application/pdf" onChange={e=>{addVersion(p,e.target.files?.[0]);e.target.value="";}}/>
                </label>
              </div>
            </article>;
          })}
        </div>
      </section>

      {catalog.projects.length>0&&<section className="space-y-3">
        <h2 className="font-display text-2xl text-landing">Project evidence</h2>
        <div className="grid gap-3 md:grid-cols-2">
          {catalog.projects.map(p=><div key={p.id} className={box}>
            <h3 className="text-sm font-semibold">{p.name}</h3>
            <p className="mt-1 text-xs leading-relaxed text-muted">{p.summary}</p>
            {p.url&&<a className="mt-2 block truncate text-xs text-brand-text underline" href={p.url} target="_blank" rel="noopener noreferrer">{p.url}</a>}
            <p className="mt-2 text-[11px] text-faint">{p.tags.join(" · ")}</p>
          </div>)}
        </div>
      </section>}
    </>}
  </main>;
}
