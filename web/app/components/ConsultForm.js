'use client';
import { useRef, useState } from 'react';

export default function ConsultForm() {
  const [state,setState]=useState({loading:false,error:'',result:null});
  const submissionId=useRef(null);
  async function submit(e){
    e.preventDefault(); setState({loading:true,error:'',result:null});
    const fd=new FormData(e.currentTarget);
    const data=Object.fromEntries(fd.entries());
    data.primary_concern=String(fd.get('primary_concern')||'');
    data.concern=data.primary_concern;
    data.concerns=[data.primary_concern,...fd.getAll('linked_concerns')];
    delete data.linked_concerns;
    data.safety_flags=fd.getAll('safety_flags');
    data.safety_screen_version='1.0';
    submissionId.current ||= crypto.randomUUID();
    data.submission_id=submissionId.current;
    data.realistic_rituals=fd.getAll('realistic_rituals');
    data.consent=true;
    try{
      const res=await fetch('/api/demo/consultations',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
      const json=await res.json();
      if(!res.ok) throw new Error(json.error||'Submission failed');
      setState({loading:false,error:'',result:json});
      if(json.whatsapp_url) window.location.assign(json.whatsapp_url);
    }catch(err){setState({loading:false,error:err.message,result:null});}
  }
  return <form onSubmit={submit} className="card stack">
    <div className="grid grid-2">
      <div className="field"><label>Name</label><input name="name" placeholder="Full name" required/></div>
      <div className="field"><label>WhatsApp</label><input name="whatsapp" placeholder="+91 98765 43210" required/></div>
      <div className="field"><label>City</label><input name="city" placeholder="City"/></div>
      <div className="field"><label>Language</label><input name="language" defaultValue="Hinglish"/></div>
      <div className="field"><label>Best time to message</label><select name="best_time_to_message" defaultValue="Afternoon"><option>Morning</option><option>Afternoon</option><option>Evening</option></select></div>
      <div className="field"><label>Primary concern</label><select name="primary_concern" defaultValue="Sleep" required><option>Calm</option><option>Sleep</option><option>Focus</option><option>Energy</option><option>Digestion</option><option>Skin</option><option>Hair</option><option>Body Comfort</option><option>Women’s Wellness</option><option>Home &amp; Aroma</option><option>Child Care</option></select></div>
      <div className="field"><label>Main goal</label><input name="main_goal" defaultValue="Fall asleep more easily"/></div>
      <div className="field"><label>Duration</label><input name="duration" defaultValue="Recently (less than 4 weeks)"/></div>
      <div className="field"><label>Daily effect</label><input name="daily_effect" defaultValue="A small nudge"/></div>
      <div className="field"><label>Appetite and digestion</label><input name="appetite_digestion" defaultValue="Steady"/></div>
      <div className="field"><label>Body climate</label><input name="body_climate" defaultValue="Usually cool"/></div>
      <div className="field"><label>Energy pattern</label><input name="energy_pattern" defaultValue="quick-dip"/></div>
      <div className="field"><label>Meal rhythm</label><input name="meal_rhythm" defaultValue="Regular"/></div>
      <div className="field"><label>Sleep rhythm</label><input name="sleep_rhythm" defaultValue="Regular"/></div>
      <div className="field"><label>Stress response</label><input name="stress_response" defaultValue="overthink"/></div>
      <div className="field"><label>Emotional support</label><input name="emotional_support" defaultValue="structure"/></div>
      <div className="field"><label>Change style</label><input name="change_style" defaultValue="small"/></div>
      <div className="field"><label>Preferred format</label><input name="preferred_format" defaultValue="infusion"/></div>
    </div>
    <div className="field"><label>Linked concerns (up to three)</label><div className="row"><label className="row"><input type="checkbox" name="linked_concerns" value="Calm" style={{width:'auto'}}/> Calm</label><label className="row"><input type="checkbox" name="linked_concerns" value="Focus" style={{width:'auto'}}/> Focus</label><label className="row"><input type="checkbox" name="linked_concerns" value="Energy" style={{width:'auto'}}/> Energy</label></div></div>
    <div className="field"><label>Safety screen</label><select name="safety_flags" defaultValue="none"><option value="none">None of the listed safety concerns</option><option value="medication">Prescription medicines</option><option value="pregnancy">Pregnancy / breastfeeding / trying to conceive</option><option value="allergy">Known allergy</option><option value="child">Plan is for a child</option></select></div>
    <div className="field"><label>Realistic rituals</label><label className="row"><input type="checkbox" name="realistic_rituals" value="A practical meal-based change" defaultChecked style={{width:'auto'}}/> A practical meal-based change</label><label className="row"><input type="checkbox" name="realistic_rituals" value="An evening wind-down" defaultChecked style={{width:'auto'}}/> An evening wind-down</label></div>
    <label className="row small"><input type="checkbox" required defaultChecked style={{width:'auto'}}/> I consent to ANJOORA using these details for review and WhatsApp communication.</label>
    {state.error&&<div className="error">{state.error}</div>}
    {state.result&&!state.result.whatsapp_url&&<div className="notice">Saved as {state.result.folio_id}. Set ANJOORA_WHATSAPP_NUMBER to enable WhatsApp redirect.</div>}
    <button className="btn" disabled={state.loading}>{state.loading?'Saving consultation…':'Submit to WhatsApp'}</button>
  </form>;
}
