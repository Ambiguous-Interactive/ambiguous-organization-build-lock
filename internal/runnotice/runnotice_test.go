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
	if err := reporter.Publish(Conclusion{
		Summary: "A condition is active. Reason: `known-condition`.",
		Warning: "A condition is active. Reason: known-condition.",
	}); err != nil {
		t.Fatal(err)
	}

	summary, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	want := "earlier step\nA condition is active. Reason: `known-condition`.\n"
	if string(summary) != want {
		t.Fatalf("summary = %q, want %q", summary, want)
	}
	if got := annotations.String(); got != "::warning::A condition is active. Reason: known-condition.\n" {
		t.Fatalf("annotations = %q", got)
	}
}

func TestPublishAppendsWithoutAnyWarning(t *testing.T) {
	t.Parallel()
	path := filepath.Join(t.TempDir(), "summary.md")
	var annotations bytes.Buffer

	if err := New(path, &annotations).Publish(Conclusion{Summary: "Clean."}); err != nil {
		t.Fatal(err)
	}

	summary, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(summary) != "Clean.\n" {
		t.Fatalf("summary = %q, want %q", summary, "Clean.\n")
	}
	if annotations.Len() != 0 {
		t.Fatalf("a clean conclusion published annotations: %q", annotations.String())
	}
}

func TestPublishCreatesTheSummaryFileWhenTheRunnerHasNot(t *testing.T) {
	t.Parallel()
	path := filepath.Join(t.TempDir(), "nested.md")

	if err := New(path, nil).Publish(Conclusion{Summary: "Clean."}); err != nil {
		t.Fatal(err)
	}
	summary, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(summary) != "Clean.\n" {
		t.Fatalf("summary = %q", summary)
	}
}

func TestPublishRefusesTextItCannotPublishSafely(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name       string
		conclusion Conclusion
		want       error
	}{
		{"empty summary", Conclusion{Summary: ""}, errNoSummary},
		{"blank summary", Conclusion{Summary: "   "}, errNoSummary},
		{"summary line break", Conclusion{Summary: "one\n::error::forged"}, errBrokenSummary},
		{"summary carriage return", Conclusion{Summary: "one\r::error::forged"}, errBrokenSummary},
		{"warning line break", Conclusion{Summary: "Clean.", Warning: "one\n::error::forged"}, errBrokenSummary},
	}
	for _, test := range cases {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			path := filepath.Join(t.TempDir(), "summary.md")
			var annotations bytes.Buffer

			err := New(path, &annotations).Publish(test.conclusion)
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

			err := New(test.path(t), &annotations).Publish(Conclusion{
				Summary: "A condition is active.",
				Warning: "A condition is active.",
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

func TestPublishFailsClosedWhenTheAnnotationStreamRejects(t *testing.T) {
	t.Parallel()
	path := filepath.Join(t.TempDir(), "summary.md")

	err := New(path, failingWriter{}).Publish(Conclusion{
		Summary: "A condition is active.",
		Warning: "A condition is active.",
	})
	if !errors.Is(err, errAnnotations) {
		t.Fatalf("Publish() error = %v, want %v", err, errAnnotations)
	}
}

func TestPublishSkipsOnlyTheSummaryWithoutAConfiguredPath(t *testing.T) {
	t.Parallel()
	var annotations bytes.Buffer

	if err := New("  ", &annotations).Publish(Conclusion{
		Summary: "A condition is active.",
		Warning: "A condition is active.",
	}); err != nil {
		t.Fatal(err)
	}
	if got := annotations.String(); !strings.HasPrefix(got, "::warning::") {
		t.Fatalf("annotations = %q", got)
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

	err = New("/dev/full", &annotations).Publish(Conclusion{
		Summary: "A condition is active.",
		Warning: "A condition is active.",
	})
	if !errors.Is(err, errSummaryWrite) {
		t.Fatalf("Publish() error = %v, want %v", err, errSummaryWrite)
	}
	if annotations.Len() != 0 {
		t.Fatalf("an unpublished conclusion still reached the annotations: %q", annotations.String())
	}
}
