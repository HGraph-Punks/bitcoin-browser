export function installCreatorModeControl(api){
  const button=document.getElementById('enter-create-mode');
  button?.addEventListener('click',async()=>{
    if(button.disabled)return;button.disabled=true;button.setAttribute('aria-busy','true');
    try{await api.creator.open();}
    catch(error){button.disabled=false;button.removeAttribute('aria-busy');const status=document.getElementById('creator-mode-error');if(status){status.hidden=false;status.textContent=error.message;}}
  });
}

installCreatorModeControl(window.satBrowser);
