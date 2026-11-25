import { useTranslation } from '../i18n'

export interface Sample {
  iteration: number
  compliance: number
  volFrac: number
}

export function ConvergenceChart({ samples, target }: { samples: Sample[]; target: number }) {
  const { t } = useTranslation()
  const width = 700
  const height = 120
  const left = 63
  const right = width - 44
  const top = 13
  const bottom = height - 22
  const count = Math.max(2, samples.length)
  const values = samples.map(sample => sample.compliance)
  const low = values.length ? Math.min(...values) : 0
  const high = values.length ? Math.max(...values) : 1
  const padding = Math.max((high - low) * 0.09, high * 0.05, 1e-9)
  const cMin = Math.max(0, low - padding)
  const cMax = high + padding
  const x = (index: number) => left + index / (count - 1) * (right - left)
  const yVolume = (value: number) => bottom - value * (bottom - top)
  const yCompliance = (value: number) => yVolume((value - cMin) / (cMax - cMin))
  const path = (y: (sample: Sample) => number) => samples
    .map((sample, i) => `${i ? 'L' : 'M'}${x(i)},${y(sample)}`).join(' ')
  const last = samples.at(-1)

  return (
    <section className="chart panel" aria-label={t('convergence')}>
      <div className="chart-heading">
        <h2>{t('convergence')}</h2>
        <div className="chart-key">
          <span><i className="key-compliance" />{t('compliance')} <small>{t('N')}·{t('mm')}</small></span>
          <span><i className="key-volume" />{t('volume')} <small>%</small></span>
        </div>
      </div>
      {last ? (
        <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={t('convergenceDescription')}>
          {[0, 0.5, 1].map(fraction => (
            <g key={fraction}>
              <line x1={left} x2={right} y1={yVolume(fraction)} y2={yVolume(fraction)} className="chart-grid" />
              <text x={left - 8} y={yVolume(fraction) + 3} textAnchor="end">
                {(cMin + fraction * (cMax - cMin)).toPrecision(3)}
              </text>
              <text x={right + 8} y={yVolume(fraction) + 3}>{Math.round(fraction * 100)}%</text>
            </g>
          ))}
          <line x1={left} x2={right} y1={yVolume(target)} y2={yVolume(target)} className="target-line" />
          <path d={path(sample => yCompliance(sample.compliance))} className="compliance-line" />
          <path d={path(sample => yVolume(sample.volFrac))} className="volume-line" />
          <circle cx={x(samples.length - 1)} cy={yCompliance(last.compliance)} r="3" className="compliance-dot" />
          <circle cx={x(samples.length - 1)} cy={yVolume(last.volFrac)} r="3" className="volume-dot" />
          <text x={left} y={height - 5}>1</text>
          <text x={width / 2} y={height - 5} textAnchor="middle">{t('iteration')}</text>
          {last.iteration > 1 && <text x={right} y={height - 5} textAnchor="end">{last.iteration}</text>}
        </svg>
      ) : (
        <div className="chart-empty">{t('chartEmpty')}</div>
      )}
    </section>
  )
}
