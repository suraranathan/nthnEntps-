export const team = [
  { id: '01', name: 'Jef', role: 'Personal Communicator', color: '#8bd6bd', state: 'Offline' },
  { id: '02', name: 'Victor', role: 'Security Officer', color: '#e7bd79', state: 'Placeholder' },
  { id: '03', name: 'Sophia', role: 'Product Manager', color: '#9db2f4', state: 'Placeholder' },
  { id: '04', name: 'Daniel', role: 'Software Architect', color: '#d4a7e6', state: 'Placeholder' },
  { id: '05', name: 'Marcus', role: 'Lead Developer', color: '#e59d91', state: 'Placeholder' },
  { id: '06', name: 'Emma', role: 'Quality Engineer', color: '#9ec6dc', state: 'Placeholder' },
  { id: '07', name: 'Oliver', role: 'Platform / DevOps Engineer', color: '#b8ce87', state: 'Placeholder' },
]
// Explicit scene facts shared with Jef. This is authored scene data, not visual perception.
export const officeContext = {
  source: 'officeLayout.ts, OfficeArchitecture.tsx and OfficeScene.tsx authored layout',
  footprint: '22 by 17 metre architectural cutaway with walnut flooring and a 2.3 metre south entrance',
  zones: ['North-west enclosed eight-seat meeting room', 'West two-person consultation room', 'Central four-desk work area: Daniel, Marcus, Emma, Oliver', 'North-east private office: Jef', 'East product office: Sophia', 'South-east security office: Victor', 'South reception and visitor waiting area'],
  limits: 'No camera vision, live scene telemetry, or employee walking. Six colleagues are seated placeholders. Activity panel entries are sample data, not verified events.',
}
