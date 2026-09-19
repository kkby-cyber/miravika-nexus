CREATE TABLE IF NOT EXISTS public.api_rate_limits (
  key text PRIMARY KEY,
  window_started_at timestamptz NOT NULL,
  request_count integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.api_rate_limits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.api_rate_limits FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.api_rate_limits TO service_role;

CREATE OR REPLACE FUNCTION public.consume_rate_limit(
  _key text,
  _limit integer,
  _window_seconds integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  current_row public.api_rate_limits%ROWTYPE;
  current_time timestamptz := now();
  elapsed integer;
BEGIN
  IF _limit < 1 OR _window_seconds < 1 OR length(_key) > 200 THEN
    RAISE EXCEPTION 'invalid rate limit arguments';
  END IF;

  SELECT * INTO current_row
  FROM public.api_rate_limits
  WHERE key = _key
  FOR UPDATE;

  IF NOT FOUND OR current_time >= current_row.window_started_at + make_interval(secs => _window_seconds) THEN
    INSERT INTO public.api_rate_limits (key, window_started_at, request_count, updated_at)
    VALUES (_key, current_time, 1, current_time)
    ON CONFLICT (key) DO UPDATE SET
      window_started_at = EXCLUDED.window_started_at,
      request_count = 1,
      updated_at = current_time;
    RETURN jsonb_build_object('allowed', true, 'remaining', _limit - 1, 'retry_after', _window_seconds);
  END IF;

  elapsed := GREATEST(1, _window_seconds - EXTRACT(EPOCH FROM (current_time - current_row.window_started_at))::integer);
  IF current_row.request_count >= _limit THEN
    RETURN jsonb_build_object('allowed', false, 'remaining', 0, 'retry_after', elapsed);
  END IF;

  UPDATE public.api_rate_limits
  SET request_count = request_count + 1, updated_at = current_time
  WHERE key = _key;
  RETURN jsonb_build_object('allowed', true, 'remaining', _limit - current_row.request_count - 1, 'retry_after', elapsed);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.consume_rate_limit(text, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_rate_limit(text, integer, integer) TO service_role;