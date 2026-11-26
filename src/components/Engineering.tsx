import { useMemo } from 'react'
import { useTranslation } from '../i18n'
import { Tooltip } from './Tooltip'
import { engineeringMetrics } from '../solver/engineering'
import type { IterationSnapshot, PassiveMasks, SimpProblem } from '../solver/types'

export function Engineering({ problem, density, frame, effectivePassive }: {
  problem: SimpProblem; density: Float32Array; frame?: IterationSnapshot; effectivePassive?: PassiveMasks
}) {
  const { t, significant: format } = useTranslation()
  const metrics = useMemo(() => engineeringMetrics({ ...problem, passive: effectivePassive }, density, frame), [problem, effectivePassive, density, frame])
  const { initialMass, mass, saved, maxDeflection, safetyFactor, p95SafetyFactor, peak, status } = metrics
  return (
    <section className="panel engineering" aria-label={t('engineering')}>
      <h2>{t('engineering')}</h2>
      <dl>
        <div><dt><Tooltip message="tipMass" info={t('mass')}>{t('mass')}</Tooltip></dt><dd>{format(initialMass)} → {format(mass)} {t('g')}</dd>
          <small>{format(saved)}% {t('saved')}</small></div>
        <div><dt><Tooltip message="tipDeflection" info={t('deflection')}>{t('deflection')}</Tooltip></dt><dd>{format(maxDeflection)} {t('mm')}</dd></div>
        <div><dt><Tooltip message="tipSafety" info={t('safety')}>{t('safety')}</Tooltip></dt><dd className={status}>{format(safetyFactor)}</dd>
          <small><Tooltip message="tipP95Safety" info={t('p95Safety')}>{t('p95Safety')} · {format(p95SafetyFactor)}</Tooltip></small>
          <small><Tooltip message="tipPeakStress" info={t('peakStress')}>{t('peakStress')} · {format(peak)} {t('MPa')}</Tooltip></small></div>
      </dl>
    </section>
  )
}
