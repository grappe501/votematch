-- Post-import checks for petition_code FIXTURE_TEST (no secrets; run in your SQL client).

-- Recent import batches
select *
from import_batches
order by created_at desc
limit 5;

-- Match outcome distribution
select match_status, count(*)
from import_voter_matches
group by match_status
order by match_status;

-- All fixture petition signatures
select *
from voter_petition_signatures
where petition_code = 'FIXTURE_TEST'
order by created_at desc;

-- Jacksonville subset for this petition
select *
from voter_petition_signatures
where lower(signer_city) = 'jacksonville'
  and petition_code = 'FIXTURE_TEST';

-- Duplicate (voter_id, petition_id) violations: should return zero rows
select voter_id, count(*)
from voter_petition_signatures
where petition_code = 'FIXTURE_TEST'
group by voter_id
having count(*) > 1;

-- Migration 002: review queue view (requires 002_review_resolution_audit.sql applied)
select count(*) as review_queue_rows
from import_review_queue
where project_key is not null;

-- Migration 002: audit tables exist
select count(*) as import_match_reviews_rows
from import_match_reviews;

select count(*) as voter_petition_signature_events_rows
from voter_petition_signature_events;

-- Migration 002: city rollup view
select *
from petition_city_counts
where petition_code = 'FIXTURE_TEST'
order by total_signers desc
limit 20;

-- Migration 002: signature audit view
select *
from petition_signature_audit
where petition_code = 'FIXTURE_TEST'
order by updated_at desc
limit 20;

-- Migration 005: reporting views (apply 005_reporting_review_views.sql)
select count(*) as batch_signature_report_rows_sample
from batch_signature_report_rows
where import_batch_id in (select id from import_batches order by created_at desc limit 3);

select count(*) as batch_review_queue_enriched_sample
from batch_review_queue_enriched
where import_batch_id in (select id from import_batches order by created_at desc limit 3);

select *
from petition_ward_signature_counts
where petition_code = 'FIXTURE_TEST'
order by ward_label;

-- Optional geo columns on permanent signatures
select column_name
from information_schema.columns
where table_schema = 'public'
  and table_name = 'voter_petition_signatures'
  and column_name in ('voter_ward', 'voter_precinct', 'voter_district');
