import { useMemo } from 'react'
import { useTranslation } from '../i18n'
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
        <div><dt>{t('mass')}</dt><dd>{format(initialMass)} → {format(mass)} {t('g')}</dd>
          <small>{format(saved)}% {t('saved')}</small></div>
        <div><dt>{t('deflection')}</dt><dd>{format(maxDeflection)} {t('mm')}</dd></div>
        <div title={t('safetyBasis')}><dt>{t('safety')}</dt><dd className={status}>{format(safetyFactor)}</dd>
          <small title={t('p95SafetyBasis')}>{t('p95Safety')} · {format(p95SafetyFactor)}</small>
          <small>{t('peakStress')} · {format(peak)} {t('MPa')}</small></div>
      </dl>
    </section>
  )
}
