package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/fred-head/repoquill/internal/app"
	"github.com/fred-head/repoquill/internal/auth"
)

var version = "dev"

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	authConfig, err := auth.ConfigFromEnvironment(os.LookupEnv)
	if err != nil {
		logger.Error("configure authentication", "error", err)
		os.Exit(1)
	}
	authService, err := auth.Open(context.Background(), authConfig, logger)
	if err != nil {
		logger.Error("initialize authentication metadata", "error", err)
		os.Exit(1)
	}
	defer authService.Close()
	authState, err := authService.State(context.Background())
	if err != nil {
		logger.Error("read authentication state", "error", err)
		os.Exit(1)
	}
	logger.Info("authentication metadata ready", "mode", authState.Mode, "modeExplicit", authState.ModeExplicit, "setupCompleted", authState.SetupCompleted, "schemaVersion", authState.SchemaVersion)
	if authState.Mode == auth.ModeDisabled {
		logger.Warn("authentication is explicitly disabled; restrict access with a trusted network or external protection")
	}
	handler, err := app.NewHandler(logger, os.Getenv("REPOQUILL_REPOSITORY"), version)
	if err != nil {
		logger.Error("configure application", "error", err)
		os.Exit(1)
	}
	server := &http.Server{
		Addr:              envOrDefault("REPOQUILL_ADDR", ":8080"),
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      6 * time.Minute,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    64 << 10,
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	go func() {
		logger.Info("repoquill started", "address", server.Addr)
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("server stopped unexpectedly", "error", err)
			os.Exit(1)
		}
	}()

	<-ctx.Done()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := server.Shutdown(shutdownCtx); err != nil {
		logger.Error("graceful shutdown failed", "error", err)
		os.Exit(1)
	}
	logger.Info("repoquill stopped")
}

func envOrDefault(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}
