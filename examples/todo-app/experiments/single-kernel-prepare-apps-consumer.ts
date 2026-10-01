import {prepareBrowserEditorDependencies,writeBrowserEditorSource} from '@kev-browser-agent-kit/opencode-chat/prepare';
const {SINGLE_KERNEL_APP_ROOT,SINGLE_KERNEL_APP_OUTPUT,RUNTIME_DIR,OPENCODE_PACKAGE_DIR}=process.env;
if(!SINGLE_KERNEL_APP_ROOT||!SINGLE_KERNEL_APP_OUTPUT||!RUNTIME_DIR||!OPENCODE_PACKAGE_DIR)throw Error('Require explicit app root, new preparation output, runtime distribution and qualified OpenCode package');
await prepareBrowserEditorDependencies({appRoot:SINGLE_KERNEL_APP_ROOT,output:SINGLE_KERNEL_APP_OUTPUT,runtimeDirectory:RUNTIME_DIR,openCodeDirectory:OPENCODE_PACKAGE_DIR});
await writeBrowserEditorSource({appRoot:SINGLE_KERNEL_APP_ROOT,output:SINGLE_KERNEL_APP_OUTPUT,source:['src','vite.config.ts','react-router.config.ts','tsconfig.json']});
console.log(SINGLE_KERNEL_APP_OUTPUT+'/prepared');
