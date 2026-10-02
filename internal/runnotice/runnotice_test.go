package runnotice

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPublishAppendsSummaryAndEmitsOneAnnotation(t *testing.T) {
	t.Parallel()
	path := filepath.Join(t.TempDir(), "summary.md")
	if err := os.WriteFile(path, []byte("earlier step\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	var annotations bytes.Buffer

	reporter := New(path, &annotations)
	if err := reporter.Publish(Notice{
		Meaning: "A condition is active.",
		Reason:  "known-condition",
		Handle:  "Incident: `incident-abc`.",
	}); err != nil {
		t.Fatal(err)
	}

	summary, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	want := "earlier step\nA condition is active. Reason: `known-condition`. Incident: `incident-abc`.\n"
	if string(summary) != want {
		t.Fatalf("summary = %q, want %q", summary, want)
	}
	wantAnnotation := "::warning::A condition is active. Reason: known-condition. Incident: incident-abc.\n"
	if annotations.String() != wantAnnotation {
		t.Fatalf("annotations = %q, want %q", annotations.String(), wantAnnotation)
	}
}

func TestPublishAppendsWithoutAnyWarning(t *testing.T) {
	t.Parallel()
	path := filepath.Join(t.TempDir(), "summary.md")
	var annotations bytes.Buffer

	if err := New(path, &annotations).Publish(Notice{
		Meaning: "No condition is active.",
		Reason:  "healthy",
	}); err != nil {
		t.Fatal(err)
	}

	summary, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(summary) != "No condition is active. Reason: `healthy`.\n" {
		t.Fatalf("summary = %q", summary)
	}
	if annotations.Len() != 0 {
		t.Fatalf("a clean conclusion published annotations: %q", annotations.String())
	}
}

func TestPublishCreatesTheSummaryFileAtTheReviewedMode(t *testing.T) {
	t.Parallel()
	path := filepath.Join(t.TempDir(), "nested.md")

	if err := New(path, nil).Publish(Notice{Meaning: "Clean.", Reason: "healthy"}); err != nil {
		t.Fatal(err)
	}
	summary, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(summary) != "Clean. Reason: `healthy`.\n" {
		t.Fatalf("summary = %q", summary)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if mode := info.Mode().Perm(); mode != summaryFileMode {
		t.Fatalf("summary file mode = %o, want %o", mode, summaryFileMode)
	}
}

func TestPublishRefusesTextItCannotPublishSafely(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name   string
		notice Notice
		want   error
	}{
		{"no meaning", Notice{Reason: "healthy"}, ErrUnstatedReason},
		{"blank meaning", Notice{Meaning: "   ", Reason: "healthy"}, ErrUnstatedReason},
		{"no reason code", Notice{Meaning: "Clean."}, errNoReasonCode},
		{"blank reason code", Notice{Meaning: "Clean.", Reason: " "}, errNoReasonCode},
		{"summary line break", Notice{Meaning: "one\n::error::forged", Reason: "healthy"}, errBrokenSummary},
		{"summary carriage return", Notice{Meaning: "one\r::error::forged", Reason: "healthy"}, errBrokenSummary},
		{
			"handle line break",
			Notice{Meaning: "Clean.", Reason: "healthy", Handle: "one\n::error::forged"},
			errBrokenSummary,
		},
	}
	for _, test := range cases {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			path := filepath.Join(t.TempDir(), "summary.md")
			var annotations bytes.Buffer

			err := New(path, &annotations).Publish(test.notice)
			if !errors.Is(err, test.want) {
				t.Fatalf("Publish() error = %v, want %v", err, test.want)
			}
			if summary, readErr := os.ReadFile(path); readErr == nil {
				t.Fatalf("a refused conclusion was published: %q", summary)
			}
			if annotations.Len() != 0 {
				t.Fatalf("a refused conclusion reached the annotations: %q", annotations.String())
			}
		})
	}
}

// A runner that sets no summary path leaves a green run with nowhere to state
// its conclusion, which is the exact gap this package closes. A missing
// annotation stream is the mirror case.
func TestPublishRefusesAChannelItCannotUse(t *testing.T) {
	t.Parallel()
	t.Run("empty summary path", func(t *testing.T) {
		t.Parallel()
		var annotations bytes.Buffer

		err := New("  ", &annotations).Publish(Notice{
			Meaning: "A condition is active.",
			Reason:  "known-condition",
			Handle:  "Incident: `incident-abc`.",
		})
		if !errors.Is(err, errNoSummaryPath) {
			t.Fatalf("Publish() error = %v, want %v", err, errNoSummaryPath)
		}
		if annotations.Len() != 0 {
			t.Fatalf("an unpublished conclusion reached the annotations: %q", annotations.String())
		}
	})
	t.Run("no annotation stream", func(t *testing.T) {
		t.Parallel()
		err := New(filepath.Join(t.TempDir(), "summary.md"), nil).Publish(Notice{
			Meaning: "A condition is active.",
			Reason:  "known-condition",
			Handle:  "Incident: `incident-abc`.",
		})
		if !errors.Is(err, errAnnotations) {
			t.Fatalf("Publish() error = %v, want %v", err, errAnnotations)
		}
	})
}

func TestPublishFailsClosedWhenTheSummaryCannotBeWritten(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name string
		path func(t *testing.T) string
	}{
		{"missing parent directory", func(t *testing.T) string {
			return filepath.Join(t.TempDir(), "absent", "summary.md")
		}},
		{"path is a directory", func(t *testing.T) string {
			return t.TempDir()
		}},
	}
	for _, test := range cases {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			var annotations bytes.Buffer

			err := New(test.path(t), &annotations).Publish(Notice{
				Meaning: "A condition is active.",
				Reason:  "known-condition",
				Handle:  "Incident: `incident-abc`.",
			})
			if !errors.Is(err, errSummaryWrite) {
				t.Fatalf("Publish() error = %v, want %v", err, errSummaryWrite)
			}
			if annotations.Len() != 0 {
				t.Fatalf("an unpublished conclusion still reached the annotations: %q", annotations.String())
			}
		})
	}
}

func TestPublishFailsClosedWhenTheSummaryWriteFails(t *testing.T) {
	t.Parallel()
	// A summary file that opens and then refuses the write is how the runner's
	// filesystem fails after the path resolved. /dev/full is the portable way to
	// ask for exactly that; a host without it skips instead of faking it.
	probe, err := os.OpenFile("/dev/full", os.O_WRONLY, 0)
	if err != nil {
		t.Skip("/dev/full is not available on this host")
	}
	if err := probe.Close(); err != nil {
		t.Fatal(err)
	}
	var annotations bytes.Buffer

	err = New("/dev/full", &annotations).Publish(Notice{
		Meaning: "A condition is active.",
		Reason:  "known-condition",
		Handle:  "Incident: `incident-abc`.",
	})
	if !errors.Is(err, errSummaryWrite) {
		t.Fatalf("Publish() error = %v, want %v", err, errSummaryWrite)
	}
	if annotations.Len() != 0 {
		t.Fatalf("an unpublished conclusion still reached the annotations: %q", annotations.String())
	}
}

func TestPublishFailsClosedWhenTheAnnotationStreamRejects(t *testing.T) {
	t.Parallel()
	path := filepath.Join(t.TempDir(), "summary.md")

	err := New(path, failingWriter{}).Publish(Notice{
		Meaning: "A condition is active.",
		Reason:  "known-condition",
		Handle:  "Incident: `incident-abc`.",
	})
	if !errors.Is(err, errAnnotations) {
		t.Fatalf("Publish() error = %v, want %v", err, errAnnotations)
	}
}

// The runner does not decode escapes inside a command message, so a percent sign
// is literal text and must not be doubled.
func TestPublishLeavesAPercentSignLiteral(t *testing.T) {
	t.Parallel()
	path := filepath.Join(t.TempDir(), "summary.md")
	var annotations bytes.Buffer

	if err := New(path, &annotations).Publish(Notice{
		Meaning: "Half the seats are in use, 50% of capacity.",
		Reason:  "healthy",
		Handle:  "Latest scheduled run: `9`.",
	}); err != nil {
		t.Fatal(err)
	}
	summary, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(summary), "50% of capacity") {
		t.Fatalf("summary = %q", summary)
	}
	if strings.Contains(annotations.String(), "%25") || !strings.Contains(annotations.String(), "50%") {
		t.Fatalf("annotation = %q", annotations.String())
	}
}

func TestUnstatedReasonCarriesNoCallerValue(t *testing.T) {
	t.Parallel()
	if strings.Contains(ErrUnstatedReason.Error(), "%") {
		t.Fatal("the refusal cause must be a fixed sentence, not a format string")
	}
}

type failingWriter struct{}

func (failingWriter) Write([]byte) (int, error) {
	return 0, errors.New("stream closed")
}
