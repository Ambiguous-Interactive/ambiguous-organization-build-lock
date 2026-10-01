package jsonstrict

import (
	"encoding/json"
	"math/rand"
	"strings"
	"testing"
)

// substitutionDetected reports whether the decoder destroyed a code point.
//
// A decoded value cannot report the loss on its own. A substituted U+FFFD and
// a real U+FFFD are the same three bytes, so both round-trip. That is why the
// guard reads the escape in the bytes. This oracle measures the other side of
// the same claim: it counts what the document spelled, and compares that with
// what the decoder produced.
//
// Both counts must cover the same region. The decoded walk visits every string
// in the document, keys included. The spelled count is therefore taken from the
// raw text with every escape normalized, so one document can spell a real
// U+FFFD and still carry a lone escape beside it.
func substitutionDetected(content []byte) bool {
	decoded, ok := decodedReplacementCount(content)
	if !ok {
		return false
	}
	return decoded > spelledReplacements(content)
}

// decodedReplacementCount counts the U+FFFD the decoder produced, across every
// string in the document.
func decodedReplacementCount(content []byte) (int, bool) {
	var decoded any
	if json.Unmarshal(content, &decoded) != nil {
		return 0, false
	}
	return countReplacements(decoded), true
}

// countReplacements walks a decoded value. Every JSON string is either a key or
// a value, so both are counted. Numbers and booleans cannot hold one.
func countReplacements(value any) int {
	switch typed := value.(type) {
	case string:
		return strings.Count(typed, "�")
	case []any:
		total := 0
		for _, element := range typed {
			total += countReplacements(element)
		}
		return total
	case map[string]any:
		total := 0
		for key, element := range typed {
			total += strings.Count(key, "�") + countReplacements(element)
		}
		return total
	default:
		return 0
	}
}

// spelledReplacements counts the U+FFFD the input carries itself, written
// either as the three raw bytes or as the escape in any hex case. The digits
// are lowercased, so no list of spellings can drift out of date.
func spelledReplacements(content []byte) int {
	count := strings.Count(string(content), "�")
	lowered := strings.ToLower(string(content))
	for offset := 0; ; {
		found := strings.Index(lowered[offset:], `\u`)
		if found < 0 {
			break
		}
		start := offset + found + 2
		offset = start
		if start+4 > len(lowered) {
			break
		}
		if lowered[start:start+4] == "fffd" {
			count++
		}
	}
	return count
}

// Over generated documents that encoding/json accepts, two properties are
// required of the guard:
//
//   - It refuses every document the decoder actually damaged. A loss can never
//     reach a decision.
//   - It refuses nothing the decoder read exactly. A reviewed file holding
//     ordinary Unicode is not blocked.
//
// The documents vary in shape as well as in content, so the proof covers keys,
// arrays, nested objects, and values beside numbers. A narrower generator would
// leave the oracle answering "no loss" for a shape it cannot decode, which is
// the direction that hides a broken guard.
func TestGuardCoversTheDecoderLoss(t *testing.T) {
	fragments := []string{
		`\ud800`, `\udc00`, `\ud83d`, `\ude00`, `\udbff`, `\udfff`,
		`\uD800`, `\uDC00`, `\uDBFF`, `\uDFFF`, `\u0041`, `\ufffd`, `\uFfFd`,
		`\\ud800`, `\\`, `z`, `x`, "\u00e9", "\U0001F600", "a", ` `,
	}
	shapes := [][2]string{
		{`{"a":"`, `"}`},
		{`{"a":["`, `"]}`},
		{`{"a":{"b":"`, `"}}`},
		{`{"a":[{"b":"`, `"}]}`},
		{`{"`, `":"v"}`},
		{`{"a":1,"b":"`, `"}`},
		{`{"a":"x","b":"`, `","c":2}`},
	}
	random := rand.New(rand.NewSource(20261001))
	accepted, damaged, refused := 0, 0, 0
	var falsePositives []string
	for iteration := 0; iteration < 200000; iteration++ {
		shape := shapes[random.Intn(len(shapes))]
		var builder strings.Builder
		builder.WriteString(shape[0])
		for count := random.Intn(6) + 1; count > 0; count-- {
			builder.WriteString(fragments[random.Intn(len(fragments))])
		}
		builder.WriteString(shape[1])
		document := []byte(builder.String())
		if !json.Valid(document) {
			continue
		}
		accepted++
		lossy := substitutionDetected(document)
		blocked := UnpairedSurrogateEscape(document)
		if lossy {
			damaged++
			if !blocked {
				t.Fatalf("the decoder damaged this document and the guard accepted it: %q",
					string(document))
			}
		} else if blocked {
			// Counted, then reported after the loop, so the summary states
			// the false-positive total even when it is zero.
			refused++
			falsePositives = append(falsePositives, string(document))
		}
	}
	if len(falsePositives) > 0 {
		t.Fatalf("the guard refused %d documents the decoder read exactly, first %q",
			len(falsePositives), falsePositives[0])
	}
	t.Logf("accepted %d documents, %d damaged and all refused, %d clean documents refused",
		accepted, damaged, refused)
	if accepted == 0 || damaged == 0 {
		t.Fatal("the generated set proved nothing")
	}
}

// The oracle only means something if it is right in both directions, so its
// own answers are pinned. Two of these rows are the faults the first version of
// the oracle had: counting rather than testing for presence, and covering the
// same region the decoded walk covers.
func TestSubstitutionOracleIsHonest(t *testing.T) {
	damaged := []string{
		`{"a":"\ud800"}`,
		`{"a":"\udc00"}`,
		`{"a":"\ufffd\ud800"}`,
		`{"a":"` + "\uFFFD" + `\ud800"}`,
		`{"a":"\uFfFd\ud800"}`,
		// A real U+FFFD in a key must not cancel a loss in a value.
		`{"\ufffd":"x\ud800"}`,
		// Shapes the first generator never produced.
		`{"a":["\ud800"]}`,
		`{"a":{"b":"\ud800"}}`,
		`{"a":1,"b":"\ud800"}`,
		`{"\ud800":"v"}`,
	}
	for _, document := range damaged {
		if !substitutionDetected([]byte(document)) {
			t.Errorf("oracle missed the damaged document %q", document)
		}
	}
	intact := []string{
		`{"a":"x"}`,
		`{"a":"\ud83d\ude00"}`,
		`{"a":"` + "\uFFFD" + `"}`,
		`{"a":"\ufffd"}`,
		`{"a":"\uFfFd"}`,
		`{"a":"\u0041\uffe9"}`,
		`{"a":["\u0041"]}`,
		`{"a":{"b":"\ud83d\ude00"}}`,
		`{"\u0041":"v"}`,
		`{"a":1,"b":"x"}`,
		// Two real U+FFFD, one in a key and one in a value, and no escape.
		`{"\ufffd":"` + "\uFFFD" + `"}`,
	}
	for _, document := range intact {
		if substitutionDetected([]byte(document)) {
			t.Errorf("oracle reported a loss for %q, which the decoder read exactly",
				document)
		}
	}
}
