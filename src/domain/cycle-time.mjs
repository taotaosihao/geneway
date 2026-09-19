export function calculateCycleTime(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return failure('INVALID_INPUT', '节拍输入必须是对象')
  if (!Object.hasOwn(input, 'availableSeconds')) return failure('MISSING_AVAILABLE_SECONDS', '缺少可用时间（秒）')
  if (!Object.hasOwn(input, 'quantity')) return failure('MISSING_QUANTITY', '缺少产量')
  if (typeof input.availableSeconds !== 'number') return failure('INVALID_AVAILABLE_SECONDS_TYPE', '可用时间必须是数字')
  if (typeof input.quantity !== 'number') return failure('INVALID_QUANTITY_TYPE', '产量必须是数字')
  if (!Number.isFinite(input.availableSeconds)) return failure('NON_FINITE_AVAILABLE_SECONDS', '可用时间必须是有限数字')
  if (!Number.isFinite(input.quantity)) return failure('NON_FINITE_QUANTITY', '产量必须是有限数字')
  if (input.availableSeconds < 0) return failure('NEGATIVE_AVAILABLE_SECONDS', '可用时间不能为负数')
  if (input.quantity <= 0) return failure('NON_POSITIVE_QUANTITY', '产量必须大于零')
  const secondsPerUnit = input.availableSeconds / input.quantity
  if (!Number.isFinite(secondsPerUnit)) return failure('NON_FINITE_RESULT', '节拍结果必须是有限数字')
  return {
    ok: true,
    availableSeconds: input.availableSeconds,
    quantity: input.quantity,
    secondsPerUnit,
    unit: 'seconds/unit',
  }
}

function failure(code, message) {
  return { ok: false, error: { code, message } }
}
