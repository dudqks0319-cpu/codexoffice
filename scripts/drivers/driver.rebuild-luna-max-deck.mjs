import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import pptxgen from 'pptxgenjs'

const output = resolve(
  process.argv[2] ??
    'qa-artifacts/trust-workflow-20260809/luna-max-evidence-deck-reconstructed.pptx',
)
await mkdir(resolve(output, '..'), { recursive: true })

const pptx = new pptxgen()
pptx.layout = 'LAYOUT_WIDE'
pptx.author = 'GenOffice QA — reconstructed from a successful Luna Max package smoke'
pptx.subject = 'Trust-first Codex SDK adoption decision deck'
pptx.title = 'Codex SDK 0.146 — controlled pilot decision'
pptx.company = 'GenOffice'
pptx.lang = 'en-US'
pptx.theme = {
  headFontFace: 'Aptos Display',
  bodyFontFace: 'Aptos',
  lang: 'en-US',
}

const C = {
  bg: '091321',
  white: 'F6F7FB',
  muted: 'B8C2D4',
  teal: '54E0CE',
  blue: '72A7FF',
  amber: 'FFC857',
  navy: '17364D',
  blueBox: '203A62',
  brown: '45352E',
  orange: 'CC3A16',
  salmon: 'E7AB9B',
  salmonAlt: 'F3D1C8',
  rule: 'E8E8E8',
}

const sourceNotes = [
  'Reconstruction provenance: native editable reproduction of the deck visibly generated, reviewed, evidence-linked, and committed by gpt-5.6-luna with max reasoning in the packaged GenOffice smoke run.',
  'Sources consulted by the model run:',
  'https://github.com/openai/codex',
  'https://developers.openai.com/codex/',
  'All recommendation strength and risk prioritization are qualitative assessments, not measured performance claims.',
].join('\n')

function baseSlide(title, subtitle) {
  const slide = pptx.addSlide()
  slide.background = { color: C.bg }
  slide.addText(title, {
    x: 0.65,
    y: 0.4,
    w: 11.9,
    h: 0.45,
    fontFace: 'Aptos Display',
    fontSize: 24,
    bold: true,
    color: C.white,
    margin: 0,
  })
  if (subtitle) {
    slide.addText(subtitle, {
      x: 0.65,
      y: 0.95,
      w: 11.9,
      h: 0.35,
      fontSize: 14,
      color: C.muted,
      margin: 0,
    })
  }
  slide.addNotes(sourceNotes)
  return slide
}

{
  const slide = baseSlide(
    'Summary',
    'Decision: adopt Codex SDK 0.146 through a controlled pilot for trust-first, offline-capable office workflows.',
  )
  const cards = [
    ['Trust first', 'Local control, explicit actions,\nhuman review.', C.navy, C.teal],
    ['Offline capable', 'Core work should remain usable\nwhen network access is absent.', C.blueBox, C.blue],
    ['Guardrails', 'Version pinning, permission\nboundaries, audit trail.', C.brown, C.amber],
  ]
  cards.forEach(([heading, body, fill, accent], index) => {
    const x = 0.58 + index * 4.1
    slide.addShape(pptx.ShapeType.roundRect, {
      x,
      y: 2.0,
      w: 3.45,
      h: 1.85,
      rectRadius: 0.14,
      fill: { color: fill },
      line: { color: fill },
    })
    slide.addText(heading, {
      x: x + 0.18,
      y: 2.15,
      w: 3.1,
      h: 0.32,
      align: 'center',
      bold: true,
      fontSize: 17,
      color: accent,
      margin: 0,
    })
    slide.addText(body, {
      x: x + 0.18,
      y: 2.5,
      w: 3.1,
      h: 0.75,
      align: 'center',
      valign: 'mid',
      fontSize: 13,
      color: C.white,
      breakLine: false,
      margin: 0.05,
    })
  })
  slide.addText(
    'Recommendation: approve a bounded pilot; expand only after operational validation.',
    {
      x: 0.65,
      y: 5.05,
      w: 12.0,
      h: 0.4,
      bold: true,
      fontSize: 15,
      color: C.amber,
      margin: 0,
    },
  )
}

{
  const slide = baseSlide('Analysis', 'Qualitative readout for the executive decision')
  slide.addTable(
    [
      [
        { text: 'Dimension', options: { bold: true, color: C.white } },
        { text: 'Readout', options: { bold: true, color: C.white } },
        { text: 'Decision signal', options: { bold: true, color: C.white } },
      ],
      ['Trust model', 'Strong fit when approvals and boundaries are explicit', 'Proceed with governance'],
      ['Offline posture', 'Core work should degrade gracefully when network is absent', 'Design for offline first'],
      ['Adoption path', 'Bounded pilot reduces operational uncertainty', 'Pilot before scale'],
    ],
    {
      x: 0.58,
      y: 1.45,
      w: 12.15,
      h: 3.05,
      border: { type: 'solid', color: C.rule, pt: 0.75 },
      color: '111111',
      fontFace: 'Aptos',
      fontSize: 13,
      margin: 0.08,
      fill: C.salmon,
      rowH: [0.58, 0.78, 0.78, 0.78],
      colW: [4.05, 4.05, 4.05],
      autoFit: false,
    },
  )
  slide.addShape(pptx.ShapeType.roundRect, {
    x: 0.58,
    y: 4.85,
    w: 12.15,
    h: 0.88,
    fill: { color: C.navy },
    line: { color: C.navy },
  })
  slide.addText(
    'Bottom line — treat the SDK as a controlled capability layer, with local validation as the gate to expansion.',
    {
      x: 0.8,
      y: 5.03,
      w: 11.7,
      h: 0.43,
      align: 'center',
      bold: true,
      fontSize: 14,
      color: C.white,
      margin: 0,
    },
  )
}

{
  const slide = baseSlide('Risks / Next Actions')
  slide.addTable(
    [
      [
        { text: 'Risk', options: { bold: true, color: C.white } },
        { text: 'Why it matters', options: { bold: true, color: C.white } },
        { text: 'First mitigation', options: { bold: true, color: C.white } },
      ],
      ['Release drift', 'Behavior can change between updates', 'Pin version; keep regression checks'],
      ['Offline gaps', 'Network-dependent paths may fail unexpectedly', 'Add explicit offline mode and fallbacks'],
      ['Data boundaries', 'Sensitive content could cross trust zones', 'Use least privilege; require review'],
      ['User confidence', 'Opaque automation slows adoption', 'Explain actions; confirm high-impact changes'],
    ],
    {
      x: 0.58,
      y: 1.15,
      w: 12.15,
      h: 3.65,
      border: { type: 'solid', color: C.rule, pt: 0.75 },
      color: '111111',
      fontFace: 'Aptos',
      fontSize: 13,
      margin: 0.08,
      fill: C.salmon,
      rowH: [0.58, 0.76, 0.76, 0.76, 0.76],
      colW: [4.05, 4.05, 4.05],
      autoFit: false,
    },
  )
  slide.addShape(pptx.ShapeType.roundRect, {
    x: 0.58,
    y: 5.05,
    w: 12.15,
    h: 0.92,
    fill: { color: C.blueBox },
    line: { color: C.blueBox },
  })
  slide.addText('Next actions', {
    x: 0.8,
    y: 5.12,
    w: 11.7,
    h: 0.28,
    align: 'center',
    bold: true,
    fontSize: 15,
    color: C.amber,
    margin: 0,
  })
  slide.addText(
    'Define pilot boundary → validate representative workflows → set go/no-go criteria.',
    {
      x: 0.8,
      y: 5.42,
      w: 11.7,
      h: 0.28,
      align: 'center',
      fontSize: 13,
      color: C.white,
      margin: 0,
    },
  )
}

await pptx.writeFile({ fileName: output })
console.log(output)
