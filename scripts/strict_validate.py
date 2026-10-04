#!/usr/bin/env python3
"""Strict v4 validation replicating DSH's Relationships state machine
(turn/start|end, step/start|end, tool advertise/start/resolve, session/title refs)
plus the tool/result.v4 and assistant.stream/envelope checks. Fails loudly."""
import os, sys, json, subprocess, shutil
NODE = os.environ.get("NODE") or shutil.which("node") or "node"
ALLOWED_KINDS = {"text", "reasoning", "tool-call", "tool-result", "image", "file"}

def fend(b, s):
    o=s+4;f=b[o];o+=1;fc=(f>>6)&3;sg=(f>>5)&1;ck=(f>>2)&1;di=f&3
    o+={0:0,1:1,2:2,3:4}[di]
    if not sg:o+=1
    o+=(1 if sg else 0) if fc==0 else {1:2,2:4,3:8}[fc]
    while True:
        h=b[o]|(b[o+1]<<8)|(b[o+2]<<16);o+=3;bt=(h>>1)&3;bs=h>>3
        o+=1 if bt==1 else bs
        if h&1:break
    if ck:o+=4
    return o

def decode(path):
    b=open(path,"rb").read();o=0;offs=[]
    while o<len(b):
        e=fend(b,o);offs.append([o,e]);o=e
    m=json.dumps({"offsets":offs})
    js='''const z=require("zlib"),fs=require("fs");const buf=fs.readFileSync(process.argv[1]);const m=JSON.parse(process.argv[2]);let q=[];for(const[s,e]of m.offsets)q.push(z.zstdDecompressSync(buf.subarray(s,e)));process.stdout.write(Buffer.concat(q));'''
    return [json.loads(l) for l in subprocess.run([NODE,"-e",js,path,m],capture_output=True).stdout.decode("utf-8").split("\n") if l.strip()]

def err(msg): raise ValueError(msg)
def isstr(v): return isinstance(v,str) and len(v)>0

def check_content(content, where):
    if not isinstance(content, list): err(f"{where}: content must be array")
    for i,blk in enumerate(content):
        if not isinstance(blk, dict): err(f"{where}: content[{i}] not object")
        t=blk.get("type")
        if t not in ALLOWED_KINDS: err(f"{where}: content[{i}] bad kind {t!r}")
        if t in ("text","reasoning") and not isinstance(blk.get("text"),str): err(f"{where}: {t} needs string text")
        if t=="tool-call" and (not isstr(blk.get("id")) or not isinstance(blk.get("name"),str) or not isinstance(blk.get("arguments"),str)): err(f"{where}: tool-call needs id/name/arguments")

def validate(evs):
    hdr=evs[0]
    if hdr.get("type")!="session" or hdr.get("version")!=4: err("bad header")
    for k in ("id","createdAt","cwd","isSeeded","delegationDepth","agentPreset"):
        if k not in hdr: err(f"header missing {k}")
    turn=None; step=None; nextTurn=1; nextStep=1; tools={}
    user_seq_source={}
    for i,e in enumerate(evs[1:]):
        ty=e.get("type"); data=e.get("data"); seq=e["seq"]
        if seq!=i: err(f"#{i} seq {seq}!={i}")
        if ty=="turn/start":
            if turn is not None or data["turn"]!=nextTurn: err(f"#{i} turn/start expected {nextTurn}")
            turn=data["turn"]; step=None; nextStep=1; tools={}
        elif ty=="turn/end":
            if turn is None or data["turn"]!=turn or step is not None: err(f"#{i} turn/end mismatch/open-step")
            reason=data.get("reason")
            if not isinstance(reason,dict) or not isstr(reason.get("kind")): err(f"#{i} turn/end.reason needs kind")
            if tools: err(f"#{i} turn/end leaves unresolved tool {next(iter(tools))}")
            turn=None; nextTurn+=1
        elif ty=="step/start":
            if turn is None or data["turn"]!=turn or step is not None or data["step"]!=nextStep: err(f"#{i} step/start mismatch (expect step {nextStep} in turn {turn})")
            step=data["step"]; nextStep+=1
        elif ty=="step/end":
            if turn is None or data["turn"]!=turn or step is None or data["step"]!=step: err(f"#{i} step/end mismatch")
            step=None
        elif ty=="user/message":
            if data.get("role")!="user": err(f"#{i} user role")
            if not isstr(data.get("id")): err(f"#{i} user id")
            check_content(data.get("content"), f"#{i} user")
            if isinstance(data.get("source"),dict): user_seq_source[seq]=data["source"].get("kind")
        elif ty=="assistant/message":
            m=data.get("message")
            if not isinstance(m,dict) or m.get("role")!="assistant": err(f"#{i} assistant message")
            if not isstr(m.get("id")): err(f"#{i} assistant id")
            if not isinstance(data.get("stream"),list): err(f"#{i} assistant stream array required")
            src=m.get("source")
            if not isinstance(src,dict) or src.get("kind")!="model": err(f"#{i} assistant source.kind model")
            check_content(m.get("content"), f"#{i} assistant")
            for blk in m["content"]:
                if blk.get("type")=="tool-call":
                    cid=blk["id"]
                    if cid in tools: err(f"#{i} assistant repeats advertised tool call {cid}")
                    tools[cid]={"name":blk["name"],"arguments":blk["arguments"],"started":False}
        elif ty=="tool/call":
            if turn is None or step is None or data.get("turn")!=turn or data.get("step")!=step: err(f"#{i} tool/call outside open step")
            cid=data.get("callId")
            if cid not in tools: err(f"#{i} tool/call {cid} not advertised in assistant content")
            p=tools[cid]
            if p["started"] or p["name"]!=data.get("name") or p["arguments"]!=data.get("arguments"): err(f"#{i} tool/call mismatch vs advertised")
            p["started"]=True
        elif ty=="tool/result":
            if turn is None or step is None or data.get("turn")!=turn or data.get("step")!=step: err(f"#{i} tool/result outside open step")
            msg=data.get("message")
            if not isinstance(msg,dict): err(f"#{i} tool/result message")
            if not isstr(msg.get("id")): err(f"#{i} tool/result message.id REQUIRED")
            if msg.get("role")!="tool": err(f"#{i} tool/result role")
            tcid=msg.get("toolCallId"); src=msg.get("source"); scid=src.get("callId") if isinstance(src,dict) else None
            if not isstr(tcid) or tcid!=scid: err(f"#{i} tool/result toolCallId!=source.callId")
            if not isinstance(src,dict) or src.get("kind")!="tool": err(f"#{i} tool/result source.kind tool")
            ie=msg.get("isError")
            if ie is not None and not isinstance(ie,bool): err(f"#{i} tool/result isError bool")
            if "error" in data and ie is not True: err(f"#{i} tool/result error w/o isError")
            check_content(msg.get("content"), f"#{i} tool/result")
            if any(isinstance(b,dict) and b.get("type")=="tool-result" for b in msg.get("content",[])): err(f"#{i} tool/result wraps tool-result")
            if tcid not in tools: err(f"#{i} tool/result {tcid} not advertised/started")
            else:
                if not tools[tcid]["started"]: err(f"#{i} tool/result before tool/call started")
                del tools[tcid]
        elif ty=="session/title":
            refs=data.get("messageSeqs")
            if not isinstance(refs,list): err(f"#{i} title messageSeqs")
            kind=(data.get("source") or {}).get("kind")
            if (len(refs)==0) != (kind=="user"): err(f"#{i} title: empty-messageSeqs must equal user-kind")
            for rseq in refs:
                if not (isinstance(rseq,int) and 0<=rseq<seq): err(f"#{i} title ref must be earlier seq")
                if user_seq_source.get(rseq)!="user": err(f"#{i} title ref must cite user/message")
    if turn is not None: err("session end with an open turn (missing turn/end)")
    if step is not None: err("session end with an open step")
    if tools: err("session end with unresolved tools")

def main():
    root=sys.argv[1]
    files=[os.path.join(root,d,"session.v4.jsonl.zstd") for d in sorted(os.listdir(root)) if os.path.isdir(os.path.join(root,d)) and d.startswith("session-")]
    fails=0
    for p in files:
        try: validate(decode(p))
        except Exception as e:
            fails+=1
            if fails<=25: print(f"FAIL {os.path.basename(os.path.dirname(p))}: {e}")
    print(f"\nstrict-validated {len(files)} sessions; failures={fails}")

if __name__=="__main__": main()
