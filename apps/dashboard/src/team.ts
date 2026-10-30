export const team = [
  { id: '01', name: 'Alex', role: 'Personal Communicator', color: '#8bd6bd', state: 'Offline' },
  { id: '02', name: 'Victor', role: 'Security Officer', color: '#e7bd79', state: 'Placeholder' },
  { id: '03', name: 'Sophia', role: 'Product Manager', color: '#9db2f4', state: 'Placeholder' },
  { id: '04', name: 'Daniel', role: 'Software Architect', color: '#d4a7e6', state: 'Placeholder' },
  { id: '05', name: 'Marcus', role: 'Lead Developer', color: '#e59d91', state: 'Placeholder' },
  { id: '06', name: 'Emma', role: 'Quality Engineer', color: '#9ec6dc', state: 'Placeholder' },
  { id: '07', name: 'Oliver', role: 'Platform / DevOps Engineer', color: '#b8ce87', state: 'Placeholder' },
]
// Explicit scene facts shared with Alex. This is authored scene data, not visual perception.
export const officeContext = {
  source: 'OfficeArchitecture.tsx and OfficeScene.tsx authored layout',
  footprint: '18 by 14 scene units; architectural cutaway with walnut flooring',
  zones: ['Upper-left enclosed private office: Alex', 'Lower-left enclosed eight-seat conference room', 'Central connected four-desk bench: Victor, Daniel, Marcus, Emma', 'Upper-right product office: Sophia', 'Lower-right platform lab: Oliver', 'South main entrance, reception and waiting sofa'],
  limits: 'No camera vision, live scene telemetry, or employee movement sensing. Other employees are placeholders. Activity panel entries are sample data, not verified events.',
}
