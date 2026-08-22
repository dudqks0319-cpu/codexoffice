import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import JSZip from 'jszip'

export async function pptxGenJsFixture(name: string): Promise<Uint8Array> {
  return new Uint8Array(
    await readFile(fileURLToPath(new URL(`./fixtures/pptxgenjs/${name}`, import.meta.url))),
  )
}

export async function pptxGenJsTextFixture(text: string, withImage = false): Promise<Uint8Array> {
  if (!/^[A-Z0-9_]+$/.test(text)) throw new Error('fixture text must stay XML-safe')
  const zip = await JSZip.loadAsync(
    await pptxGenJsFixture(withImage ? 'image-template.pptx' : 'text-template.pptx'),
  )
  const path = 'ppt/slides/slide1.xml'
  const xml = await zip.file(path)!.async('string')
  if (!xml.includes('__TEXT__')) throw new Error('PptxGenJS fixture token is missing')
  zip.file(path, xml.replace('__TEXT__', text))
  return zip.generateAsync({ type: 'uint8array' })
}
