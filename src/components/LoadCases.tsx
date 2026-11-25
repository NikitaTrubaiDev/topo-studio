import type { LoadCase } from '../solver/types'

const colors = ['#ffb676', '#80d7ff', '#d7acff', '#9df3a0', '#ff9cc0', '#f4e478']

export function caseColor(index: number) {
  return colors[index] ?? `hsl(${(index * 137.508) % 360} 78% ${index % 2 ? 65 : 76}%)`
}

export function LoadCases({ cases, active, onSelect, onAdd, onRemove, onRename }: {
  cases: readonly LoadCase[]
  active: number
  onSelect: (index: number) => void
  onAdd: () => void
  onRemove: () => void
  onRename: (name: string) => void
}) {
  return (
    <section aria-label="Load case manager">
      <h3>Load cases</h3>
      <div className="case-list" role="group" aria-label="Active load case">
        {cases.map((load, index) => (
          <button className="case-row" key={index} type="button" aria-pressed={active === index} onClick={() => onSelect(index)}>
            <i style={{ backgroundColor: caseColor(index) }} />
            <span>{load.name || `Case ${index + 1}`}</span>
            <small>{load.forces.length}</small>
          </button>
        ))}
      </div>
      <label htmlFor="case-name">Case name</label>
      <input id="case-name" className="field-input" key={`${active} ${cases[active].name}`} defaultValue={cases[active].name} maxLength={48}
        onBlur={event => {
          const name = event.target.value.trim() || cases[active].name
          event.target.value = name
          if (name !== cases[active].name) onRename(name)
        }}
        onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur() }} />
      <div className="action-row">
        <button className="tool-button" type="button" onClick={onAdd}>Add case</button>
        <button className="tool-button" type="button" onClick={onRemove} disabled={cases.length === 1}>Remove</button>
      </div>
    </section>
  )
}
