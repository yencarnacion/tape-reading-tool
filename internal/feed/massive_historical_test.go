package feed

import (
	"testing"
	"time"
)

func TestMassiveResumePointSuppressesOnlySeenRecordsAtTimestamp(t *testing.T) {
	resume := newMassiveResumePoint(100)
	if !resume.accept(100, "first") {
		t.Fatal("first record at inclusive resume timestamp was rejected")
	}
	if resume.accept(100, "first") {
		t.Fatal("duplicate record at resume timestamp was accepted")
	}
	if !resume.accept(100, "second") {
		t.Fatal("distinct record at the same timestamp was rejected")
	}
	if !resume.accept(101, "next") {
		t.Fatal("record after resume timestamp was rejected")
	}
	if resume.accept(100, "late") {
		t.Fatal("record older than resume timestamp was accepted")
	}
}

func TestMassiveHistoricalRetryDelayIsBounded(t *testing.T) {
	wants := []time.Duration{time.Second, 2 * time.Second, 4 * time.Second, 8 * time.Second, 16 * time.Second, 30 * time.Second, 30 * time.Second}
	for index, want := range wants {
		if got := massiveHistoricalRetryDelay(index + 1); got != want {
			t.Fatalf("attempt %d delay = %s, want %s", index+1, got, want)
		}
	}
}
