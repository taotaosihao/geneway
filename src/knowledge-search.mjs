const SEGMENT_CHARACTERS = 800
const SEGMENT_OVERLAP = 80
const MAX_RESULTS = 6
const MAX_QUERY_TERMS = 16

export function segmentKnowledgeBody(body) {
  const paragraphs = body.replaceAll('\r\n', '\n').split(/\n\s*\n+/).map(item => item.trim()).filter(Boolean)
  return paragraphs.flatMap((paragraph, paragraphIndex) => {
    const characters = Array.from(paragraph)
    const segments = []
    for (let start = 0; start < characters.length; start += SEGMENT_CHARACTERS - SEGMENT_OVERLAP) {
      segments.push({
        segmentId: `p${paragraphIndex + 1}-c${start + 1}`,
        text: characters.slice(start, start + SEGMENT_CHARACTERS).join(''),
      })
      if (start + SEGMENT_CHARACTERS >= characters.length) break
    }
    return segments
  })
}

export function searchKnowledgeMaterials(materials, query) {
  const terms = [...new Set(normalize(query).split(/[^\p{L}\p{N}_-]+/u).filter(Boolean))]
  if (!terms.length) return []
  if (terms.length > MAX_QUERY_TERMS) {
    const error = new RangeError(`检索词项不能超过 ${MAX_QUERY_TERMS} 个`)
    error.code = 'TOO_MANY_QUERY_TERMS'
    throw error
  }

  return materials.flatMap(material => {
    const title = normalize(material.title)
    const titleScore = terms.reduce((sum, term) => sum + occurrences(title, term) * 8, 0)
    return segmentKnowledgeBody(material.body).map(segment => {
      const normalizedText = normalize(segment.text)
      return { material, segment, score: titleScore + terms.reduce((sum, term) => sum + occurrences(normalizedText, term), 0) }
    })
  }).filter(item => item.score > 0)
    .sort((left, right) => right.score - left.score
      || compareCodeUnits(left.material.id, right.material.id)
      || left.material.revision - right.material.revision
      || compareCodeUnits(left.segment.segmentId, right.segment.segmentId))
    .slice(0, MAX_RESULTS)
    .map(({ material, segment }) => ({
      knowledgeId: material.id,
      revision: material.revision,
      segmentId: segment.segmentId,
      title: material.title,
      source: material.sourceLabel,
      text: segment.text,
    }))
}

function normalize(value) {
  return value.normalize('NFKC').toLowerCase()
}

function occurrences(value, term) {
  let count = 0
  for (let offset = 0; (offset = value.indexOf(term, offset)) !== -1; offset += term.length) count += 1
  return count
}

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}
