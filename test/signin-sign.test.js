// 钉住 MiniMax 网关签名：算法一变，签到立刻 400 invalid signature
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { signRequest } from '../lib/signin.js'

test('GET（空请求体）按 md5(ts + 盐) 签', () => {
  const { 'x-timestamp': ts, 'x-signature': sig } = signRequest({ timestamp: 1_700_000_000, body: '' })
  assert.equal(ts, '1700000000')
  assert.equal(sig, '05064c6d0266350eeac121b673536c14') // 实测过网关的已知答案
})

test('POST claim 把请求体一起签进去', () => {
  const a = signRequest({ timestamp: 1_700_000_000, body: '{}' })
  const b = signRequest({ timestamp: 1_700_000_000, body: '' })
  assert.notEqual(a['x-signature'], b['x-signature'])
})

test('时间戳取当前秒', () => {
  const before = Math.floor(Date.now() / 1000)
  const { 'x-timestamp': ts } = signRequest()
  assert.ok(Number(ts) >= before && Number(ts) <= before + 1)
})
