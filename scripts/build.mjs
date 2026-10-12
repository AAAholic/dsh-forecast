import { build } from 'esbuild'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
const result = await build({absWorkingDir:root,entryPoints:[resolve(root,'lib/client/index.mjs')],bundle:true,write:false,format:'cjs',platform:'browser',target:'es2022',external:['react','react-dom'],legalComments:'none'})
const body = result.outputFiles[0].text
const code = `window.__ModuleLoader__.load({id:${JSON.stringify(manifest.name)},factory:(require)=>{var module={exports:{}};var exports=module.exports;\n${body}\nreturn module.exports;}});\n`
const output = resolve(root,'lib/client.js')
if(process.argv.includes('--check')) {
  if(await readFile(output,'utf8')!==code)throw new Error('Client bundle is stale; run npm run build')
  console.log('Client bundle is current')
} else {await writeFile(output,code);console.log('Client bundle built')}
