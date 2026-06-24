// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

// Package xk6otel provides a k6 extension that lets load test scripts create
// OpenTelemetry root spans and propagate them to the system under test via
// W3C traceparent headers. Register with xk6 as "k6/x/otel".
package xk6otel

import (
	"context"
	"fmt"
	"os"
	"strings"
	"sync"

	"github.com/grafana/sobek"
	"go.k6.io/k6/v2/js/modules"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.24.0"
	"go.opentelemetry.io/otel/trace"
)

func init() {
	modules.Register("k6/x/otel", New())
}

// ---- global TracerProvider (shared across all VUs) --------------------------

var (
	globalTracer trace.Tracer
	providerOnce sync.Once
	providerErr  error
)

func initProvider() {
	providerOnce.Do(func() {
		ctx := context.Background()

		endpoint := os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT")
		if endpoint == "" {
			endpoint = "localhost:4317"
		}
		// gRPC exporter expects host:port without a scheme
		endpoint = strings.TrimPrefix(endpoint, "https://")
		endpoint = strings.TrimPrefix(endpoint, "http://")

		exp, err := otlptracegrpc.New(ctx,
			otlptracegrpc.WithEndpoint(endpoint),
			otlptracegrpc.WithInsecure(),
		)
		if err != nil {
			providerErr = fmt.Errorf("xk6-otel: creating OTLP trace exporter: %w", err)
			return
		}

		serviceName := os.Getenv("OTEL_SERVICE_NAME")
		if serviceName == "" {
			serviceName = "load-generator"
		}

		res, err := resource.New(ctx,
			resource.WithFromEnv(),
			resource.WithAttributes(semconv.ServiceName(serviceName)),
		)
		if err != nil {
			// non-fatal: fall back to default resource
			res = resource.Default()
		}

		tp := sdktrace.NewTracerProvider(
			sdktrace.WithBatcher(exp),
			sdktrace.WithResource(res),
			sdktrace.WithSampler(sdktrace.AlwaysSample()),
		)
		globalTracer = tp.Tracer("load-generator")
	})
}

// ---- k6 module wiring -------------------------------------------------------

// RootModule is the module factory; one instance exists for the whole test run.
type RootModule struct{}

// ModuleInstance is created once per VU that imports the module.
type ModuleInstance struct{ vu modules.VU }

var (
	_ modules.Module   = &RootModule{}
	_ modules.Instance = &ModuleInstance{}
)

// New returns the RootModule that k6 calls to create per-VU instances.
func New() *RootModule { return &RootModule{} }

func (*RootModule) NewModuleInstance(vu modules.VU) modules.Instance {
	return &ModuleInstance{vu: vu}
}

// Exports surfaces the named export { Tracer } to JavaScript.
func (m *ModuleInstance) Exports() modules.Exports {
	return modules.Exports{
		Named: map[string]any{
			"Tracer": m.newTracer,
		},
	}
}

// newTracer is called when the script does `new Tracer()`. Sobek recognises
// the ConstructorCall signature and treats the function as a JS constructor.
func (m *ModuleInstance) newTracer(call sobek.ConstructorCall, rt *sobek.Runtime) *sobek.Object {
	initProvider()
	if providerErr != nil {
		panic(rt.NewGoError(providerErr))
	}

	// Attach startSpan to the newly constructed object (call.This).
	if err := call.This.Set("startSpan", makeStartSpan(rt)); err != nil {
		panic(rt.NewGoError(err))
	}

	return nil // returning nil tells sobek to use call.This as the result of `new`
}

// makeStartSpan returns the JS function that scripts call as tracer.startSpan().
func makeStartSpan(rt *sobek.Runtime) func(sobek.FunctionCall) sobek.Value {
	return func(fc sobek.FunctionCall) sobek.Value {
		name := fc.Argument(0).String()

		var kvs []attribute.KeyValue
		if len(fc.Arguments) > 1 && !sobek.IsUndefined(fc.Argument(1)) {
			kvs = jsObjToAttrs(fc.Argument(1).ToObject(rt))
		}

		_, span := globalTracer.Start(
			context.Background(),
			name,
			trace.WithAttributes(kvs...),
			trace.WithSpanKind(trace.SpanKindClient),
		)

		obj := rt.NewObject()
		if err := obj.Set("traceParent", makeTraceParent(span)); err != nil {
			panic(rt.NewGoError(err))
		}
		if err := obj.Set("end", span.End); err != nil {
			panic(rt.NewGoError(err))
		}
		return rt.ToValue(obj)
	}
}

// makeTraceParent returns the W3C traceparent for the given span as a JS callable.
// Scripts call span.traceParent() (with parens) to get the header value string.
func makeTraceParent(span trace.Span) func() string {
	return func() string {
		sc := span.SpanContext()
		return fmt.Sprintf("00-%s-%s-01", sc.TraceID(), sc.SpanID())
	}
}

// ---- attribute conversion ---------------------------------------------------

// jsObjToAttrs converts a JS plain object of span attributes to OTel KeyValues.
// JS numbers export as float64; strings, bools, and unknown types are handled too.
func jsObjToAttrs(obj *sobek.Object) []attribute.KeyValue {
	keys := obj.Keys()
	kvs := make([]attribute.KeyValue, 0, len(keys))
	for _, k := range keys {
		switch v := obj.Get(k).Export().(type) {
		case string:
			kvs = append(kvs, attribute.String(k, v))
		case float64:
			kvs = append(kvs, attribute.Float64(k, v))
		case int64:
			kvs = append(kvs, attribute.Int64(k, v))
		case bool:
			kvs = append(kvs, attribute.Bool(k, v))
		default:
			kvs = append(kvs, attribute.String(k, fmt.Sprintf("%v", v)))
		}
	}
	return kvs
}
