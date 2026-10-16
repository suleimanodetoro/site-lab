import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RunReport } from './types.js';
import { formatDuration } from './progress.js';
import { writeJson } from './util.js';

const cell = (value: unknown) => String(value).replaceAll('|', '\\|').replaceAll('\n', ' ').slice(0, 200);
export async function writeReport(report: RunReport) {
  const effects = report.passes.flatMap(p => p.effects.map(effect => ({ ...effect, pass: `${p.engine}-${p.width}` }))).filter(e => !e.property.startsWith('box.')).sort((a, b) => b.magnitude - a.magnitude).slice(0, 25);
  const assets: Record<string, number> = {};
  for (const asset of report.assets) assets[asset.type] = (assets[asset.type] ?? 0) + 1;
  const primary = report.passes.find(p => p.engine === 'chromium') ?? report.passes[0];
  const warnings = [...new Set(report.warnings)];
  // Keep all pass timings and settling counts without growing the summary past v1's limit.
  const timingGroups = new Map<string, { stage: string; durationMs: number }[]>();
  for (const timing of report.timings ?? []) {
    const name = timing.stage.split(' ')[0]; const group = timingGroups.get(name) ?? [];
    group.push(timing); timingGroups.set(name, group);
  }
  const lines = [
    '# Capture summary', '', `Source: ${cell(report.url)}`, `Result: ${cell(report.status)}`, `Status: ${cell(report.status)}`, ...(report.interruptedStage ? [`Interrupted stage: ${cell(report.interruptedStage)}`] : []), `Preflight: ${cell(report.ethics)}`, ...(report.consent ? [`Consent banner: ${cell(report.consent.action)} (${cell(report.consent.detail)})`] : []),
    ...(report.gate && report.gate.action !== 'none' ? [`Entry gate: ${cell(report.gate.action)} (${cell(report.gate.detail)}); the gate screen is <pass>/screenshots/gate.png`] : []), '',
    ...(report.breakpoints ? ['## Breakpoints', `Found in the site's CSS and scripts: ${report.breakpoints.found.map(b => `${b.kind}-width ${b.px}px (×${b.count})`).join(', ') || 'none'}.`,
      `Read from: the page's stylesheets${report.breakpoints.fetchedSheets ? `, ${report.breakpoints.fetchedSheets} cross-origin stylesheet(s) fetched as text` : ''}${report.breakpoints.scriptQueries ? `, ${report.breakpoints.scriptQueries} matchMedia quer${report.breakpoints.scriptQueries === 1 ? 'y' : 'ies'} from scripts` : ''}.`,
      `Captured widths: ${report.breakpoints.widths.join(', ')}px.`, ''] : []),
    ...(report.passes.length ? ['## Scroll steps (use the same step per width when capturing a rebuild)',
      ...report.passes.map(p => `- ${p.engine}-${p.width}: ${p.virtualExtent !== undefined ? `the page does not scroll; driven by ${p.virtualDriver === 'wheel' ? `mouse-wheel flicks (${p.scrollStep}px and up)` : p.virtualDriver === 'drag' ? 'dragging' : `the ${p.virtualDriver} key`} for ${p.steps} steps (y in curves and step screenshots is input distance, ${p.virtualExtent}px in total)` : `every ${p.scrollStep ?? '?'}px`}${p.layoutOnly ? ' (layout only: no motion curves or hover)' : ''}`), ''] : []),
    ...(report.timedChanges ? ['## Timed changes (happen on their own, not from scrolling)', '| Pass | Element | Kind | Values | Every | Cycles |', '| --- | --- | --- | --- | ---: | --- |',
      ...Object.entries(report.timedChanges).flatMap(([pass, list]) => list.filter(c => !c.continuous).slice(0, 12).map(c => `| ${pass} | ${cell(c.path.slice(-70))} | ${c.kind} | ${cell(c.values.slice(0, 5).join(' → '))} | ${c.medianIntervalMs === null ? '–' : `${(c.medianIntervalMs / 1000).toFixed(1)}s`} | ${c.cycles ? 'yes' : 'no'} |`)),
      ...Object.entries(report.timedChanges).map(([pass, list]) => `${pass}: ${list.filter(c => c.continuous).length} continuous loops (marquees, spinners) not listed.`), ''] : []),
    '## Libraries', ...report.libraries.map(l => `- ${l.name}${l.version ? ` ${l.version}` : ''}: ${l.reachable ? 'global reachable' : 'signature only'}; ${l.evidence.map(cell).join('; ')}`), '',
    '## Counts (per pass; repeated elements and animations are not unique)',
    '| Pass | Elements | WAAPI | ScrollTriggers | Pinned ranges | Hover |', '| --- | ---: | ---: | ---: | ---: | ---: |',
    ...report.passes.slice(0, 20).map(p => `| ${p.engine}-${p.width} | ${p.elements} | ${p.waapi} | ${p.scrollTriggers} | ${p.pinned} | ${p.hover} |`),
    ...(report.passes.length > 20 ? [`Further ${report.passes.length - 20} passes in summary.json.`] : []),
    '', `Assets: ${report.assets.length}; by type: ${Object.entries(assets).map(([type, count]) => `${type} ${count}`).join(', ') || 'none'}.`, '',
    '## Settling', '| Pass | Timed-out steps | Percentage |', '| --- | ---: | ---: |',
    ...(['chromium', 'webkit'] as const).flatMap(engine => {
      const passes = report.passes.filter(p => p.engine === engine);
      return passes.length ? [`| ${passes.map(p => `${p.engine}-${p.width}`).join('<br>')} | ${passes.map(p => `${p.timedOutSteps ?? 0}/${p.steps ?? 0}`).join('<br>')} | ${passes.map(p => `${p.steps ? ((p.timedOutSteps ?? 0) / p.steps * 100).toFixed(1) : '0.0'}%`).join('<br>')} |`] : [];
    }), '',
    '## Timing', '| Stage | Duration |', '| --- | ---: |',
    ...[...timingGroups.values()].map(group => `| ${group.map(t => cell(t.stage)).join('<br>')} | ${group.map(t => formatDuration(t.durationMs)).join('<br>')} |`), '',
    '## Top 25 scroll effects by numeric magnitude (units differ by property)',
    'Measured values; shape/easing are estimates. Pin plateaus are inferred from viewport positions.',
    '| Pass | Element | Property | Scroll | From → to | Shape / ease | Fit MSE |', '| --- | --- | --- | --- | --- | --- | ---: |',
    ...effects.map(e => `| ${e.pass} | ${cell(e.path)}${e.insideAmbient ? ' (inside looping animation)' : ''} | ${e.property} | ${e.start}–${e.end} | ${cell(e.from)} → ${cell(e.to)} | ${e.shape} / ${cell(e.ease)} | ${e.error.toPrecision(3)} |`), '',
    `## Top type and colour tokens (${primary ? `${primary.engine}-${primary.width}` : 'no completed pass'})`,
    '| Type | Count |', '| --- | ---: |', ...(primary?.tokens.fonts ?? []).slice(0, 10).map(t => `| ${cell(t.value)} | ${t.count} |`), '',
    '| Colour | Count |', '| --- | ---: |', ...(primary?.tokens.colours ?? []).slice(0, 10).map(t => `| ${cell(t.value)} | ${t.count} |`), '',
    '## Warnings', ...warnings.slice(0, 10).map(w => `- ${cell(w)}`), ...(warnings.length > 10 ? [`- ${warnings.length - 10} further warnings in summary.json.`] : []), ...(warnings.length ? [] : ['- None.']), '',
    '## Key files', '- SOURCE.md — provenance and advisory checks', '- network.har — first Chromium pass (if requested)', '- assets/manifest.json — response inventory', '- <engine>-<width>/ — DOM, styles, computed data, tokens, aria, screenshots and hover', '- motion/ — library inventory, timelines, scroll curves and effects; optional WebKit data in motion/webkit/', '- video/ — MP4 tours, slowed intros, pointer tour and every slowed-intro frame (frames-intro-slow-<width>/*.jpg)', '- summary.json — full machine-readable report, including all warnings'
  ];
  await writeFile(join(report.out, 'SUMMARY.md'), lines.join('\n') + '\n');
  await writeJson(join(report.out, 'summary.json'), report);
}
