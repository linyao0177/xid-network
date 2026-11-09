;; A billing rule for compute nodes: the energy a meter measured over a
;; window of readings, and what it costs. Integer arithmetic only, so every
;; node that runs it on the same readings gets the same answer.
;;
;; Readings: n cumulative watt-hour counters, i64, at memory offset 0.
;; bill(n, price) -> the bill in token base units for the energy between the
;; first and last reading, at `price` base units per kWh, rounded down.
;; A counter that goes backwards (a reset) counts from zero again.
(module
  (memory (export "memory") 1)
  (func (export "bill") (param $n i32) (param $price i64) (result i64)
    (local $i i32) (local $prev i64) (local $cur i64) (local $wh i64)
    (if (i32.lt_s (local.get $n) (i32.const 2)) (then (return (i64.const 0))))
    (local.set $prev (i64.load (i32.const 0)))
    (local.set $i (i32.const 1))
    (block $done
      (loop $next
        (br_if $done (i32.ge_s (local.get $i) (local.get $n)))
        (local.set $cur (i64.load (i32.mul (local.get $i) (i32.const 8))))
        (if (i64.ge_u (local.get $cur) (local.get $prev))
          (then (local.set $wh (i64.add (local.get $wh) (i64.sub (local.get $cur) (local.get $prev)))))
          (else (local.set $wh (i64.add (local.get $wh) (local.get $cur)))))
        (local.set $prev (local.get $cur))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $next)))
    (i64.div_u (i64.mul (local.get $wh) (local.get $price)) (i64.const 1000)))
)
