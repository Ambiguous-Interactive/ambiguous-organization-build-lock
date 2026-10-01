package jsonstrict

import (
	"encoding/json"
	"math/rand"
	"strings"
	"testing"
)

// substitutionDetected reports whether the decoder destroyed a code point: the
// decoded text holds more U+FFFD than the input spelled.
//
// A decoded value cannot detect the loss on its own. A substituted U+FFFD and a
// real U+FFFD are the same three bytes, so decoding and re-encoding either
// document gives the same result. That is the reason the guard reads the escape
// instead of the decoded value, and this test pins both halves of the claim.
// Counting rather than testing for presence matters, because one document can
// spell a real U+FFFD and still carry a lone escape.
func substitutionDetected(content []byte) bool {
	var decoded map[string]string
	if json.Unmarshal(content, &decoded) != nil {
		return false
	}
	decodedCount := 0
	for _, value := range decoded {
		decodedCount += strings.Count(value, "�")
	}
	return decodedCount > spelledReplacements(content)
}

// spelledReplacements counts the U+FFFD the input carries itself, written
// either as the three raw bytes or as any hex case of the escape.
func spelledReplacements(content []byte) int {
	document := string(content)
	count := strings.Count(document, "�")
	for _, escape := range []string{`\ufffd`, `\uFFFD`, `\ufffD`, `\uFfFd`, `\uFffd`} {
		count += strings.Count(document, escape)
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
func TestGuardCoversTheDecoderLoss(t *testing.T) {
	fragments := []string{
		`\ud800`, `\udc00`, `\ud83d`, `\ude00`, `\udbff`, `\udfff`,
		`\uD800`, `\uDC00`, `\uDBFF`, `\uDFFF`, `\u0041`, `\ufffd`,
		`\\ud800`, `\\`, `z`, `x`, "\u00e9", "\U0001F600", "a", ` `,
	}
	random := rand.New(rand.NewSource(20261001))
	accepted, damaged, refused := 0, 0, 0
	var falsePositives []string
	for iteration := 0; iteration < 200000; iteration++ {
		var builder strings.Builder
		builder.WriteString(`{"a":"`)
		for count := random.Intn(6) + 1; count > 0; count-- {
			builder.WriteString(fragments[random.Intn(len(fragments))])
		}
		builder.WriteString(`"}`)
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
// own answers are pinned. In particular a document that spells one U+FFFD and
// still carries a lone escape must be reported, which is why the oracle counts
// instead of testing for presence.
func TestSubstitutionOracleIsHonest(t *testing.T) {
	refused := []string{
		`{"a":"\ud800"}`,
		`{"a":"\udc00"}`,
		`{"a":"\ufffd\ud800"}`,
		`{"a":"` + "\uFFFD" + `\ud800"}`,
	}
	for _, document := range refused {
		if !substitutionDetected([]byte(document)) {
			t.Errorf("oracle missed the damaged document %q", document)
		}
	}
	intact := []string{
		`{"a":"x"}`,
		`{"a":"\ud83d\ude00"}`,
		`{"a":"` + "\uFFFD" + `"}`,
		`{"a":"\ufffd"}`,
		`{"a":"\u0041\uffe9"}`,
	}
	for _, document := range intact {
		if substitutionDetected([]byte(document)) {
			t.Errorf("oracle reported a loss for %q, which the decoder read exactly",
				document)
		}
	}
}
