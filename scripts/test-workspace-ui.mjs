import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createContext, runInContext, Script } from 'node:vm'

const html = await readFile(new URL('../web/index.html', import.meta.url), 'utf8')
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1]
new Script(script)
const section = (from, to) => script.slice(script.indexOf(from), script.indexOf(to))
const state = { bootstrap: { employees: [{ id: 'a', name: '生产助理' }] }, channels: { deliveries: [{ workId: 'delivered', status: 'blocked' }] }, conversationSelection: 4, conversationReadRequest: 8, selectedConversationId: 'selected', currentConversation: { id: 'selected' }, conversationDrafts: { selected: { text: '未发送的草稿' } } }
const works = [
  { id: 'running', employeeId: 'a', goal: 'A 线生产', status: 'accepted' },
  { id: 'waiting', goal: '交接核对', status: 'waiting_input' },
  { id: 'completed', goal: '节拍计算', status: 'completed' },
  { id: 'delivered', goal: '渠道通知', status: 'completed' },
]
let shown
const box = createContext({ state, works, Date, show: view => { shown = view }, tpmMode: () => null })
runInContext(section('    const active=', '    const displayTime=') + section('    function workName(', '    function nextStep(') + section('    function filterWorkList(', '    function renderWorkLists(') + section('    function closeConversation(', '    function renderConversationPlaceholder('), box)
const ids = expression => JSON.parse(JSON.stringify(runInContext(expression, box))).map(work => work.id)
assert.deepEqual(ids('filterWorkList(works," a 线 ")'), ['running'])
assert.deepEqual(ids('filterWorkList(works,"生产助理")'), ['running'])
assert.deepEqual(ids('filterWorkList(works,"","running")'), ['running'])
assert.deepEqual(ids('filterWorkList(works,"","attention")'), ['waiting', 'delivered'])
assert.deepEqual(ids('filterWorkList(works,"节拍","completed")'), ['completed'])
assert.deepEqual(ids('filterWorkList(works,"无匹配")'), [])
runInContext(script.split('\n').filter(line => /^    const (labels|deliveryLabels)=/.test(line)).join('\n') + '\n' + section('    const esc=', '    const active=') + section('    function nextStep(', '    function filterWorkList('), box)
const ordered = { id: 'order', goal: '核对 <A> 线', input: { workOrderId: 'WO-001' }, status: 'waiting_input', requiredInputs: ['quantity'], employeeId: 'a' }
box.ordered = ordered
const orderCard = runInContext('workCard(ordered)', box)
assert.match(orderCard, /<h3>WO-001<\/h3>/)
assert.match(orderCard, /class="work-goal">核对 &lt;A&gt; 线<\/p>/, 'an order reference must not hide the distinct work goal')
assert.match(orderCard, /补充 数量 后继续/)
assert.doesNotMatch(runInContext('workCard(works[0])', box), /class="work-goal"/, 'a goal already used as the title is not repeated')
runInContext('closeConversation()', box)
assert.equal(state.conversationSelection, 5, 'returning to the list invalidates a pending open')
assert.equal(state.conversationReadRequest, 9, 'returning to the list invalidates a pending refresh')
assert.equal(state.selectedConversationId, null)
assert.equal(state.currentConversation, null)
assert.equal(state.conversationDrafts.selected.text, '未发送的草稿')
assert.equal(shown, 'conversations')
const controls = new Map(['work-search', 'work-status'].map(id => [id, { value: 'previous member input' }]))
box.el = id => { if (!controls.has(id)) controls.set(id, { dataset: {}, classList: { add() {} }, reset() {} }); return controls.get(id) }
box.setMessage = () => {}
runInContext(section('    function clearConversationState(', '    function conversationDraft('), box)
runInContext('clearConversationState()', box)
assert.equal(controls.get('work-search').value, '')
assert.equal(controls.get('work-status').value, 'all')
console.log('Workspace UI checks passed: work search/status/attention composition and conversation back invalidation with draft retention')
