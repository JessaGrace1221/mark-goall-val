const express = require('express');
const cors    = require('cors');
const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');
const bcrypt  = require('bcryptjs');
const {AsyncLocalStorage} = require('async_hooks');
const multer  = require('multer');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const {createGhlMcpService} = require('./services/ghlMcpService');
const {
  normalizeEmailAddress,
  normalizePhoneNumber,
  sanitizeDecisionMaker,
  validEmail,
  validPhone
} = require('./services/leadContactValidation');
const app     = express();

app.use(cors());
app.use(express.json({limit:'10mb'}));
app.set('trust proxy',1);
const upload = multer({storage:multer.memoryStorage(),limits:{fileSize:25*1024*1024}});

function normalizePublicBaseUrl(value){
  let raw=String(value||'').trim();
  if(!raw && process.env.RAILWAY_PUBLIC_DOMAIN) raw=`https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  if(!raw) return '';
  if(/^ttps:\/\//i.test(raw)) raw='h'+raw;
  if(!/^https?:\/\//i.test(raw)) raw=`https://${raw}`;
  return raw.replace(/\/+$/,'');
}

function slugifyClient(value){
  return String(value||'')
    .toLowerCase()
    .replace(/^https?:\/\//,'')
    .replace(/\.up\.railway\.app.*$/,'')
    .replace(/\.railway\.app.*$/,'')
    .replace(/-production(?:-[a-z0-9]+)?$/,'')
    .replace(/[^a-z0-9]+/g,'-')
    .replace(/^-+|-+$/g,'')
    .slice(0,80);
}

const NORMALIZED_PUBLIC_BASE_URL = normalizePublicBaseUrl(process.env.VAL_PUBLIC_BASE_URL);
const DERIVED_CLIENT_SLUG = slugifyClient(process.env.VAL_CLIENT_SLUG)
  || slugifyClient(NORMALIZED_PUBLIC_BASE_URL)
  || slugifyClient(process.env.RAILWAY_SERVICE_NAME)
  || slugifyClient(process.env.RAILWAY_PROJECT_NAME)
  || 'val-core';

const CLIENT_CONFIG = {
  clientName: process.env.VAL_CLIENT_NAME || 'VAL User',
  clientSlug: DERIVED_CLIENT_SLUG,
  brandName: process.env.VAL_CLIENT_BRAND_NAME || process.env.VAL_CLIENT_NAME || 'VAL',
  logoUrl: process.env.VAL_CLIENT_LOGO_URL || process.env.VAL_LOGO_URL || '',
  publicBaseUrl: NORMALIZED_PUBLIC_BASE_URL,
  timezone: process.env.VAL_DEFAULT_TIMEZONE || 'America/New_York',
  supportEmail: process.env.VAL_SUPPORT_EMAIL || process.env.SUPPORT_EMAIL || '',
  projectName: process.env.VAL_PROJECT_NAME || '',
  projectType: process.env.VAL_PROJECT_TYPE || ''
};
const DEMO_MODE = /^(1|true|yes)$/i.test(String(process.env.VAL_DEMO_MODE || ''));
const VAL_SIGNUP_URL = process.env.VAL_SIGNUP_URL || 'https://graceintelligence.com/val';
const GHL_KEY = process.env.GHL_KEY || process.env.GHL_API_KEY;
const GHL_LOC = process.env.GHL_LOC || process.env.GHL_LOCATION_ID;
const GHL_ACCOUNT_SLUGS = String(process.env.GHL_ACCOUNT_SLUGS || '').split(',').map(v=>v.trim()).filter(Boolean);
const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;
const OPENAI_KEY = process.env.OPENAI_KEY;
const OPENAI_CHAT_MODEL = process.env.VAL_CHAT_MODEL || 'gpt-5.5';
const ROCKETREACH_API_KEY = process.env.ROCKETREACH_API_KEY;
const ROCKETREACH_BASE_URL = process.env.ROCKETREACH_BASE_URL || 'https://api.rocketreach.co/api/v2';
const APOLLO_API_KEY = process.env.APOLLO_API_KEY;
const APOLLO_BASE_URL = process.env.APOLLO_BASE_URL || 'https://api.apollo.io/api/v1';
const OUTSCRAPER_API_KEY = process.env.OUTSCRAPER_API_KEY;
const OUTSCRAPER_LINKEDIN_POSTS_URL = process.env.OUTSCRAPER_LINKEDIN_POSTS_URL || '';
const OUTSCRAPER_GOOGLE_MAPS_SEARCH_URL = process.env.OUTSCRAPER_GOOGLE_MAPS_SEARCH_URL || 'https://api.app.outscraper.com/maps/search-v3';
const GHL_CALENDAR_ID = process.env.GHL_CALENDAR_ID || '';
const GHL_CALENDAR_IDS = String(process.env.GHL_CALENDAR_IDS || GHL_CALENDAR_ID || '').split(',').map(v=>v.trim()).filter(Boolean);
const GHL_OPPORTUNITY_PIPELINE_ID = process.env.GHL_OPPORTUNITY_PIPELINE_ID || process.env.GHL_PIPELINE_ID || '';
const GHL_OPPORTUNITY_STAGE_ID = process.env.GHL_OPPORTUNITY_STAGE_ID || process.env.GHL_PIPELINE_STAGE_ID || '';
const GHL_OPPORTUNITY_PIPELINE_NAME = process.env.GHL_OPPORTUNITY_PIPELINE_NAME || 'GOALL';
const GHL_OPPORTUNITY_STAGE_NAME = process.env.GHL_OPPORTUNITY_STAGE_NAME || 'New Lead';
const GHL_PARTNER_PIPELINE_ID = process.env.GHL_PARTNER_PIPELINE_ID || '';
const GHL_PARTNER_STAGE_ID = process.env.GHL_PARTNER_STAGE_ID || '';
const GHL_PARTNER_PIPELINE_NAME = process.env.GHL_PARTNER_PIPELINE_NAME || 'GOALL Strategic Partners';
const GHL_PARTNER_STAGE_NAME = process.env.GHL_PARTNER_STAGE_NAME || 'New Limitless Lead Added';
const MICROSOFT_CLIENT_ID = process.env.MICROSOFT_CLIENT_ID || '';
const MICROSOFT_CLIENT_SECRET = process.env.MICROSOFT_CLIENT_SECRET || '';
const MICROSOFT_REDIRECT_URI = process.env.MICROSOFT_REDIRECT_URI || (CLIENT_CONFIG.publicBaseUrl ? `${CLIENT_CONFIG.publicBaseUrl.replace(/\/$/,'')}/auth/microsoft/callback` : '');
const MICROSOFT_SCOPES = String(process.env.MICROSOFT_SCOPES || 'offline_access User.Read Mail.Read Calendars.Read').split(/\s+/).filter(Boolean);
const GOALL_LEAD_SEARCH_MAX = Number(process.env.GOALL_LEAD_SEARCH_MAX) || 200;
const GOALL_LEAD_RAW_SEARCH_MAX = Number(process.env.GOALL_LEAD_RAW_SEARCH_MAX) || Math.max(GOALL_LEAD_SEARCH_MAX*4,200);
const GOALL_LEAD_SEARCH_CALLS_MAX = Number(process.env.GOALL_LEAD_SEARCH_CALLS_MAX) || 28;
const GOALL_LEAD_DISCOVERY_TIMEOUT_MS = Number(process.env.GOALL_LEAD_DISCOVERY_TIMEOUT_MS) || 120000;
const GOALL_LEAD_IMPORT_CONCURRENCY = Math.min(Math.max(Number(process.env.GOALL_LEAD_IMPORT_CONCURRENCY)||4,1),10);
const OUTSCRAPER_FETCH_TIMEOUT_MS = Number(process.env.OUTSCRAPER_FETCH_TIMEOUT_MS) || 14000;
const OPENAI_WEB_RESEARCH_TIMEOUT_MS = Number(process.env.OPENAI_WEB_RESEARCH_TIMEOUT_MS) || 12000;
const GOALL_PIPELINE_MINIMUM = Number(process.env.GOALL_PIPELINE_MINIMUM) || 300;
const GOALL_COMPANY_EMPLOYEE_MINIMUM = Number(process.env.GOALL_COMPANY_EMPLOYEE_MINIMUM) || 10;
const GOALL_ARIZONA_CITIES = [
  'Phoenix','Scottsdale','Mesa','Tempe','Chandler','Gilbert','Glendale','Peoria',
  'Tucson','Flagstaff','Yuma','Prescott','Surprise','Avondale','Goodyear'
];
const GOALL_PRIORITY_INDUSTRIES_ARIZONA = [
  'trucking companies',
  'construction companies',
  'general contractors',
  'electrical contractors',
  'plumbing companies',
  'HVAC companies',
  'roofing companies',
  'welding companies',
  'concrete contractors',
  'landscaping companies',
  'restoration companies',
  'solar installers',
  'manufacturing companies',
  'machine shops',
  'metal fabrication companies',
  'logistics companies',
  'warehousing companies',
  'staffing agencies',
  'home care agencies',
  'medical practices',
  'dental offices',
  'chiropractic offices',
  'physical therapy clinics',
  'behavioral health clinics',
  'veterinary clinics',
  'law offices',
  'accounting firms',
  'wealth management firms',
  'insurance agencies',
  'marketing agencies',
  'consulting firms',
  'engineering firms',
  'architecture firms',
  'auto repair shops',
  'collision centers',
  'equipment rental companies',
  'commercial cleaning companies',
  'security companies',
  'property management companies',
  'commercial real estate firms',
  'restaurants',
  'catering companies',
  'hotels',
  'fitness centers',
  'private schools',
  'childcare centers'
];
const VAL_LEAD_PROFILE = String(process.env.VAL_LEAD_PROFILE || '').trim().toLowerCase();
const WESTWOOD_LEAD_PROFILE_ENABLED = VAL_LEAD_PROFILE==='westwood' || /westwood/i.test(`${CLIENT_CONFIG.clientName} ${CLIENT_CONFIG.clientSlug} ${CLIENT_CONFIG.brandName} ${CLIENT_CONFIG.projectName} ${CLIENT_CONFIG.projectType}`);
CLIENT_CONFIG.leadProfile = VAL_LEAD_PROFILE || (WESTWOOD_LEAD_PROFILE_ENABLED ? 'westwood' : 'goall');
const WESTWOOD_IDAHO_CITIES = ['Boise','Meridian','Nampa','Idaho Falls','Pocatello','Caldwell',"Coeur d'Alene",'Twin Falls','Lewiston','Rexburg'];
const WESTWOOD_PRIORITY_INDUSTRIES = [
  'manufacturing companies',
  'construction companies',
  'engineering firms',
  'architecture firms',
  'professional services firms',
  'law firms',
  'accounting firms',
  'CPA firms',
  'financial advisory firms',
  'insurance agencies',
  'healthcare practices',
  'chiropractic offices',
  'dental offices',
  'physical therapy clinics',
  'staffing agencies',
  'logistics companies',
  'trucking companies',
  'technology companies',
  'SaaS companies',
  'managed IT service providers',
  'marketing agencies',
  'consulting firms',
  'real estate brokerages',
  'property management companies',
  'home care agencies',
  'private schools',
  'hospitality groups',
  'multi-location service businesses',
  'family-owned businesses',
  'companies with leadership teams'
];
let rocketReachLimitedUntil = 0;
const requestContext = new AsyncLocalStorage();
const GHL_LEAD_FIELD_IDS = {
  lead_source_system: process.env.GHL_FIELD_LEAD_SOURCE_SYSTEM || '',
  lead_ingested_at: process.env.GHL_FIELD_LEAD_INGESTED_AT || '',
  lead_ingestion_id: process.env.GHL_FIELD_LEAD_INGESTION_ID || '',
  lead_processing_status: process.env.GHL_FIELD_LEAD_PROCESSING_STATUS || '',
  painpoint: process.env.GHL_FIELD_PAINPOINT || '',
  call_transcript: process.env.GHL_FIELD_CALL_TRANSCRIPT || '',
  lead_dedupe_key: process.env.GHL_FIELD_LEAD_DEDUPE_KEY || '',
  lead_monitoring_enabled: process.env.GHL_FIELD_LEAD_MONITORING_ENABLED || '',
  company_payload: process.env.GHL_FIELD_COMPANY_PAYLOAD || '',
  google_raw: process.env.GHL_FIELD_GOOGLE_RAW || process.env.GHL_FIELD_COMPANY_GOOGLE_RAW || '',
  company_signals: process.env.GHL_FIELD_COMPANY_SIGNALS || process.env.GHL_FIELD_COMPANY_SIGNALS_RAW || '',
  enrichment_data: process.env.GHL_FIELD_ENRICHMENT_DATA || '',
  ai_exact_industry: process.env.GHL_FIELD_AI_EXACT_INDUSTRY || '',
  business_category_secondary: process.env.GHL_FIELD_BUSINESS_CATEGORY_SECONDARY || '',
  google_place_id: process.env.GHL_FIELD_GOOGLE_PLACE_ID || '',
  google_maps_url: process.env.GHL_FIELD_GOOGLE_MAPS_URL || '',
  google_review_count: process.env.GHL_FIELD_GOOGLE_REVIEW_COUNT || '',
  google_rating: process.env.GHL_FIELD_GOOGLE_RATING || '',
  google_reviews_snippet: process.env.GHL_FIELD_GOOGLE_REVIEWS_SNIPPET || '',
  approximat_donor_count: process.env.GHL_FIELD_APPROXIMAT_DONOR_COUNT || process.env.GHL_FIELD_APPROXIMATE_DONOR_COUNT || '',
  linkedin_personal: process.env.GHL_FIELD_LINKEDIN_PERSONAL || process.env.GHL_FIELD_LINKEDIN_PERSONAL_URL || '',
  linkedin_company: process.env.GHL_FIELD_LINKEDIN_COMPANY || process.env.GHL_FIELD_LINKEDIN_COMPANY_URL || '',
  linkedin_company_id: process.env.GHL_FIELD_LINKEDIN_COMPANY_ID || '',
  linkedin_employee_count: process.env.GHL_FIELD_LINKEDIN_EMPLOYEE_COUNT || '',
  linkedin_company_size_band: process.env.GHL_FIELD_LINKEDIN_COMPANY_SIZE_BAND || '',
  linkedin_company_description: process.env.GHL_FIELD_LINKEDIN_COMPANY_DESCRIPTION || '',
  linkedin_company_location: process.env.GHL_FIELD_LINKEDIN_COMPANY_LOCATION || '',
  linkedin_company_founded_year: process.env.GHL_FIELD_LINKEDIN_COMPANY_FOUNDED_YEAR || '',
  linkedin_match_confidence: process.env.GHL_FIELD_LINKEDIN_MATCH_CONFIDENCE || '',
  linkedin_match_notes: process.env.GHL_FIELD_LINKEDIN_MATCH_NOTES || '',
  linkedin_current_title: process.env.GHL_FIELD_LINKEDIN_CURRENT_TITLE || '',
  linkedin_profile_location: process.env.GHL_FIELD_LINKEDIN_PROFILE_LOCATION || '',
  signals_summary: process.env.GHL_FIELD_SIGNALS_SUMMARY || '',
  signals_positive_count: process.env.GHL_FIELD_SIGNALS_POSITIVE_COUNT || '',
  signals_top_indicators: process.env.GHL_FIELD_SIGNALS_TOP_INDICATORS || '',
  signals_confidence: process.env.GHL_FIELD_SIGNALS_CONFIDENCE || '',
  signals_last_checked_at: process.env.GHL_FIELD_SIGNALS_LAST_CHECKED_AT || '',
  indicator_type: process.env.GHL_FIELD_INDICATOR_TYPE || '',
  indicator_direction: process.env.GHL_FIELD_INDICATOR_DIRECTION || '',
  indicator_confidence: process.env.GHL_FIELD_INDICATOR_CONFIDENCE || '',
  indicator_summary: process.env.GHL_FIELD_INDICATOR_SUMMARY || '',
  indicator_source_type: process.env.GHL_FIELD_INDICATOR_SOURCE_TYPE || '',
  indicator_detected_at: process.env.GHL_FIELD_INDICATOR_DETECTED_AT || '',
  indicator_sales_angle: process.env.GHL_FIELD_INDICATOR_SALES_ANGLE || '',
  indicator_requires_attention: process.env.GHL_FIELD_INDICATOR_REQUIRES_ATTENTION || '',
  workforce_stability_signal: process.env.GHL_FIELD_WORKFORCE_STABILITY_SIGNAL || '',
  layoff_signal_detected: process.env.GHL_FIELD_LAYOFF_SIGNAL_DETECTED || '',
  layoff_signal_confidence: process.env.GHL_FIELD_LAYOFF_SIGNAL_CONFIDENCE || '',
  layoff_signal_summary: process.env.GHL_FIELD_LAYOFF_SIGNAL_SUMMARY || '',
  leadership_change_detected: process.env.GHL_FIELD_LEADERSHIP_CHANGE_DETECTED || '',
  leadership_change_summary: process.env.GHL_FIELD_LEADERSHIP_CHANGE_SUMMARY || '',
  hiring_freeze_signal: process.env.GHL_FIELD_HIRING_FREEZE_SIGNAL || '',
  review_sentiment_trend: process.env.GHL_FIELD_REVIEW_SENTIMENT_TREND || '',
  monitoring_cadence: process.env.GHL_FIELD_MONITORING_CADENCE || '',
  last_indicator_check_at: process.env.GHL_FIELD_LAST_INDICATOR_CHECK_AT || '',
  indicator_change_detected: process.env.GHL_FIELD_INDICATOR_CHANGE_DETECTED || '',
  last_indicator_notification_sent_at: process.env.GHL_FIELD_LAST_INDICATOR_NOTIFICATION_SENT_AT || '',
  indicator_notification_suppressed_until: process.env.GHL_FIELD_INDICATOR_NOTIFICATION_SUPPRESSED_UNTIL || '',
  account_intelligence_summary: process.env.GHL_FIELD_ACCOUNT_INTELLIGENCE_SUMMARY || '',
  latest_indicator_update: process.env.GHL_FIELD_LATEST_INDICATOR_UPDATE || '',
  signals_negative_count: process.env.GHL_FIELD_SIGNALS_NEGATIVE_COUNT || '',
  enrichment_run_id: process.env.GHL_FIELD_ENRICHMENT_RUN_ID || '',
  enrichment_error: process.env.GHL_FIELD_ENRICHMENT_ERROR || '',
  hours_of_operation: process.env.GHL_FIELD_HOURS_OF_OPERATION || '',
  time_zone: process.env.GHL_FIELD_TIME_ZONE || '',
  lead_score: process.env.GHL_FIELD_LEAD_SCORE || '',
  lead_score_reason: process.env.GHL_FIELD_LEAD_SCORE_REASON || '',
  lead_scored_at: process.env.GHL_FIELD_LEAD_SCORED_AT || '',
  lead_rejected_reason: process.env.GHL_FIELD_LEAD_REJECTED_REASON || '',
  lead_scoring_version: process.env.GHL_FIELD_LEAD_SCORING_VERSION || '',
  scraped_annual_revenue: process.env.GHL_FIELD_SCRAPED_ANNUAL_REVENUE || (WESTWOOD_LEAD_PROFILE_ENABLED?'A8VvWiqnOUL2qCf2SqoF':''),
  scraped_number_of_employees: process.env.GHL_FIELD_SCRAPED_NUMBER_OF_EMPLOYEES || (WESTWOOD_LEAD_PROFILE_ENABLED?'WBP8IVZg9ktkreh6fjI7':''),
  industry: process.env.GHL_FIELD_INDUSTRY || '',
  title: process.env.GHL_FIELD_TITLE || (WESTWOOD_LEAD_PROFILE_ENABLED?'tde7FEbWJciyuTb37ykf':''),
  contact_payload: process.env.GHL_FIELD_CONTACT_PAYLOAD || '',
  raw_company_signals: process.env.GHL_FIELD_RAW_COMPANY_SIGNALS || '',
  enrichment_status: process.env.GHL_FIELD_ENRICHMENT_STATUS || '',
  call_script_angle: process.env.GHL_FIELD_CALL_SCRIPT_ANGLE || '',
  recommended_outreach_angle: process.env.GHL_FIELD_RECOMMENDED_OUTREACH_ANGLE || '',
  news_count_last_60_days: process.env.GHL_FIELD_NEWS_COUNT_LAST_60_DAYS || '',
  ai_company_summary: process.env.GHL_FIELD_AI_COMPANY_SUMMARY || '',
  account_priority_level: process.env.GHL_FIELD_ACCOUNT_PRIORITY_LEVEL || '',
  call_script: process.env.GHL_FIELD_CALL_SCRIPT || '',
  linkedin_notes: process.env.GHL_FIELD_LINKEDIN_NOTES || '',
  raw_company_context_json: process.env.GHL_FIELD_RAW_COMPANY_CONTEXT_JSON || '',
  raw_company_context_result_count: process.env.GHL_FIELD_RAW_COMPANY_CONTEXT_RESULT_COUNT || '',
  raw_news_result_count: process.env.GHL_FIELD_RAW_NEWS_RESULT_COUNT || '',
  raw_linkedin_company_data: process.env.GHL_FIELD_RAW_LINKEDIN_COMPANY_DATA || '',
  raw_linkedin_personal_data: process.env.GHL_FIELD_RAW_LINKEDIN_PERSONAL_DATA || '',
  raw_web_result_count: process.env.GHL_FIELD_RAW_WEB_RESULT_COUNT || '',
  raw_company_context_notes: process.env.GHL_FIELD_RAW_COMPANY_CONTEXT_NOTES || '',
  raw_enrichment_notes: process.env.GHL_FIELD_RAW_ENRICHMENT_NOTES || '',
  linkedin_url: process.env.GHL_FIELD_LINKEDIN_URL || '',
  lead_enrichment_status: process.env.GHL_FIELD_LEAD_ENRICHMENT_STATUS || (WESTWOOD_LEAD_PROFILE_ENABLED?'3YjYoF6jR77sQiYirngE':''),
  lead_last_processed_at: process.env.GHL_FIELD_LEAD_LAST_PROCESSED_AT || (WESTWOOD_LEAD_PROFILE_ENABLED?'MztG71A3i1FQh1PBrn0a':''),
  raw_web_signals_json: process.env.GHL_FIELD_RAW_WEB_SIGNALS_JSON || (WESTWOOD_LEAD_PROFILE_ENABLED?'M9tL3Ist82if2h5cMLPq':''),
  news_raw_last_60_days: process.env.GHL_FIELD_NEWS_RAW_LAST_60_DAYS || (WESTWOOD_LEAD_PROFILE_ENABLED?'oeHHUB8pfjtRXZEhASfi':''),
  automation_tag: process.env.GHL_FIELD_AUTOMATION_TAG || '',
  automation_tag_reason: process.env.GHL_FIELD_AUTOMATION_TAG_REASON || '',
  normalized_industry: process.env.GHL_FIELD_NORMALIZED_INDUSTRY || '',
  raw_industry: process.env.GHL_FIELD_RAW_INDUSTRY || '',
  tag_confidence: process.env.GHL_FIELD_TAG_CONFIDENCE || '',
  needs_new_automation: process.env.GHL_FIELD_NEEDS_NEW_AUTOMATION || '',
  suggested_new_automation_tag: process.env.GHL_FIELD_SUGGESTED_NEW_AUTOMATION_TAG || '',
  estimated_employee_count: process.env.GHL_FIELD_ESTIMATED_EMPLOYEE_COUNT || '',
  employee_count_confidence: process.env.GHL_FIELD_EMPLOYEE_COUNT_CONFIDENCE || '',
  employee_count_note: process.env.GHL_FIELD_EMPLOYEE_COUNT_NOTE || '',
  growth_signals: process.env.GHL_FIELD_GROWTH_SIGNALS || '',
  leadership_signals: process.env.GHL_FIELD_LEADERSHIP_SIGNALS || '',
  workforce_pain_signals: process.env.GHL_FIELD_WORKFORCE_PAIN_SIGNALS || '',
  engagement_activity_signals: process.env.GHL_FIELD_ENGAGEMENT_ACTIVITY_SIGNALS || '',
  decision_maker_name: process.env.GHL_FIELD_DECISION_MAKER_NAME || '',
  decision_maker_title: process.env.GHL_FIELD_DECISION_MAKER_TITLE || '',
  decision_maker_email: process.env.GHL_FIELD_DECISION_MAKER_EMAIL || '',
  decision_maker_phone: process.env.GHL_FIELD_DECISION_MAKER_PHONE || '',
  decision_maker_linkedin: process.env.GHL_FIELD_DECISION_MAKER_LINKEDIN || '',
  company_linkedin: process.env.GHL_FIELD_COMPANY_LINKEDIN || '',
  goall_intelligence_note: process.env.GHL_FIELD_GOALL_INTELLIGENCE_NOTE || '',
  recommended_first_call_angle: process.env.GHL_FIELD_RECOMMENDED_FIRST_CALL_ANGLE || '',
  missing_data: process.env.GHL_FIELD_MISSING_DATA || '',
  partner_type: process.env.GHL_FIELD_PARTNER_TYPE || '',
  organization_size: process.env.GHL_FIELD_ORGANIZATION_SIZE || '',
  potential_reach: process.env.GHL_FIELD_POTENTIAL_REACH || '',
  partnership_fit_score: process.env.GHL_FIELD_PARTNERSHIP_FIT_SCORE || '',
  reason_for_score: process.env.GHL_FIELD_REASON_FOR_SCORE || '',
  source_urls: process.env.GHL_FIELD_SOURCE_URLS || '',
  date_added: process.env.GHL_FIELD_DATE_ADDED || ''
};
const GHL_LEAD_FIELD_KEYS = {
  lead_source_system:'contact.lead_source_system',
  lead_ingested_at:'contact.lead_ingested_at',
  lead_ingestion_id:'contact.lead_ingestion_id',
  lead_processing_status:'contact.lead_processing_status',
  painpoint:'contact.painpoint',
  call_transcript:'contact.call_transcript',
  lead_dedupe_key:'contact.lead_dedupe_key',
  lead_monitoring_enabled:'contact.lead_monitoring_enabled',
  company_payload:'contact.company_payload',
  google_raw:'contact.google_raw',
  company_signals:'contact.company_signals',
  enrichment_data:'contact.enrichment_data',
  ai_exact_industry:'contact.ai_exact_industry',
  business_category_secondary:'contact.business_category_secondary',
  google_place_id:'contact.google_place_id',
  google_maps_url:'contact.google_maps_url',
  google_review_count:'contact.google_review_count',
  google_rating:'contact.google_rating',
  google_reviews_snippet:'contact.google_reviews_snippet',
  approximat_donor_count:'contact.approximat_donor_count',
  linkedin_personal:'contact.linkedin_personal',
  linkedin_company:'contact.linkedin_company',
  linkedin_company_id:'contact.linkedin_company_id',
  linkedin_employee_count:'contact.linkedin_employee_count',
  linkedin_company_size_band:'contact.linkedin_company_size_band',
  linkedin_company_description:'contact.linkedin_company_description',
  linkedin_company_location:'contact.linkedin_company_location',
  linkedin_company_founded_year:'contact.linkedin_company_founded_year',
  linkedin_match_confidence:'contact.linkedin_match_confidence',
  linkedin_match_notes:'contact.linkedin_match_notes',
  linkedin_current_title:'contact.linkedin_current_title',
  linkedin_profile_location:'contact.linkedin_profile_location',
  signals_summary:'contact.signals_summary',
  signals_positive_count:'contact.signals_positive_count',
  signals_top_indicators:'contact.signals_top_indicators',
  signals_confidence:'contact.signals_confidence',
  signals_last_checked_at:'contact.signals_last_checked_at',
  indicator_type:'contact.indicator_type',
  indicator_direction:'contact.indicator_direction',
  indicator_confidence:'contact.indicator_confidence',
  indicator_summary:'contact.indicator_summary',
  indicator_source_type:'contact.indicator_source_type',
  indicator_detected_at:'contact.indicator_detected_at',
  indicator_sales_angle:'contact.indicator_sales_angle',
  indicator_requires_attention:'contact.indicator_requires_attention',
  workforce_stability_signal:'contact.workforce_stability_signal',
  layoff_signal_detected:'contact.layoff_signal_detected',
  layoff_signal_confidence:'contact.layoff_signal_confidence',
  layoff_signal_summary:'contact.layoff_signal_summary',
  leadership_change_detected:'contact.leadership_change_detected',
  leadership_change_summary:'contact.leadership_change_summary',
  hiring_freeze_signal:'contact.hiring_freeze_signal',
  review_sentiment_trend:'contact.review_sentiment_trend',
  monitoring_cadence:'contact.monitoring_cadence',
  last_indicator_check_at:'contact.last_indicator_check_at',
  indicator_change_detected:'contact.indicator_change_detected',
  last_indicator_notification_sent_at:'contact.last_indicator_notification_sent_at',
  indicator_notification_suppressed_until:'contact.indicator_notification_suppressed_until',
  account_intelligence_summary:'contact.account_intelligence_summary',
  latest_indicator_update:'contact.latest_indicator_update',
  signals_negative_count:'contact.signals_negative_count',
  enrichment_run_id:'contact.enrichment_run_id',
  enrichment_error:'contact.enrichment_error',
  hours_of_operation:'contact.hours_of_operation',
  time_zone:'contact.time_zone',
  lead_score:'contact.lead_score',
  lead_score_reason:'contact.lead_score_reason',
  lead_scored_at:'contact.lead_scored_at',
  lead_rejected_reason:'contact.lead_rejected_reason',
  lead_scoring_version:'contact.lead_scoring_version',
  scraped_annual_revenue:'contact.scraped_annual_revenue',
  scraped_number_of_employees:'contact.scraped_number_of_employees',
  industry:'contact.industry',
  title:'contact.title',
  contact_payload:'contact.contact_payload',
  raw_company_signals:'contact.raw_company_signals',
  enrichment_status:'contact.enrichment_status',
  call_script_angle:'contact.call_script_angle',
  recommended_outreach_angle:'contact.recommended_outreach_angle',
  news_count_last_60_days:'contact.news_count_last_60_days',
  ai_company_summary:'contact.ai_company_summary',
  account_priority_level:'contact.account_priority_level',
  call_script:'contact.call_script',
  linkedin_notes:'contact.linkedin_notes',
  raw_company_context_json:'contact.raw_company_context_json',
  raw_company_context_result_count:'contact.raw_company_context_result_count',
  raw_news_result_count:'contact.raw_news_result_count',
  raw_linkedin_company_data:'contact.raw_linkedin_company_data',
  raw_linkedin_personal_data:'contact.raw_linkedin_personal_data',
  raw_web_result_count:'contact.raw_web_result_count',
  raw_company_context_notes:'contact.raw_company_context_notes',
  raw_enrichment_notes:'contact.raw_enrichment_notes',
  linkedin_url:'contact.linkedin_url',
  lead_enrichment_status:'contact.lead_enrichment_status',
  lead_last_processed_at:'contact.lead_last_processed_at',
  raw_web_signals_json:'contact.raw_web_signals_json',
  news_raw_last_60_days:'contact.news_raw_last_60_days',
  automation_tag:'contact.automation_tag',
  automation_tag_reason:'contact.automation_tag_reason',
  normalized_industry:'contact.normalized_industry',
  raw_industry:'contact.raw_industry',
  tag_confidence:'contact.tag_confidence',
  needs_new_automation:'contact.needs_new_automation',
  suggested_new_automation_tag:'contact.suggested_new_automation_tag',
  estimated_employee_count:'contact.estimated_employee_count',
  employee_count_confidence:'contact.employee_count_confidence',
  employee_count_note:'contact.employee_count_note',
  growth_signals:'contact.growth_signals',
  leadership_signals:'contact.leadership_signals',
  workforce_pain_signals:'contact.workforce_pain_signals',
  engagement_activity_signals:'contact.engagement_activity_signals',
  decision_maker_name:'contact.decision_maker_name',
  decision_maker_title:'contact.decision_maker_title',
  decision_maker_email:'contact.decision_maker_email',
  decision_maker_phone:'contact.decision_maker_phone',
  decision_maker_linkedin:'contact.decision_maker_linkedin',
  company_linkedin:'contact.company_linkedin',
  goall_intelligence_note:'contact.goall_intelligence_note',
  recommended_first_call_angle:'contact.recommended_first_call_angle',
  missing_data:'contact.missing_data',
  partner_type:'contact.partner_type',
  organization_size:'contact.organization_size',
  potential_reach:'contact.potential_reach',
  partnership_fit_score:'contact.partnership_fit_score',
  reason_for_score:'contact.reason_for_score',
  source_urls:'contact.source_urls',
  date_added:'contact.date_added'
};
const GHL_LEAD_FIELD_NAME_ALIASES = {
  lead_source_system:['lead source system','lead_source_system'],
  lead_ingested_at:['lead ingested at','lead_ingested_at'],
  lead_ingestion_id:['lead ingestion id','lead_ingestion_id'],
  lead_processing_status:['lead processing status','lead_processing_status'],
  painpoint:['painpoint','pain point'],
  call_transcript:['call transcript','call_transcript'],
  lead_dedupe_key:['lead dedupe key','lead_dedupe_key'],
  lead_monitoring_enabled:['lead monitoring enabled','lead_monitoring_enabled'],
  company_payload:['company payload','company_payload'],
  google_raw:['google raw','google_raw'],
  company_signals:['company signals','company_signals'],
  enrichment_data:['enrichment data','enrichment_data'],
  ai_exact_industry:['ai exact industry','ai_exact_industry','exact industry'],
  business_category_secondary:['business category secondary','business_category_secondary'],
  google_place_id:['google place id','google_place_id'],
  google_maps_url:['google maps url','google_maps_url'],
  google_review_count:['google review count','google_review_count','review count'],
  google_rating:['google rating','google_rating'],
  google_reviews_snippet:['google reviews snippet','google_reviews_snippet','review snippet','reviews snippet'],
  lead_score:['lead score','lead_score','goall lead score','goall score','priority score','lead priority score','lead score 1-4','lead score 1 4','call priority score','call center score'],
  lead_score_reason:['lead score reason','lead_score_reason','goall lead score reason','goall score reason','score reason','priority score reason','lead priority reason','call priority reason','call center score reason'],
  lead_scored_at:['lead scored at','lead_scored_at'],
  lead_rejected_reason:['lead rejected reason','lead_rejected_reason','rejected reason'],
  lead_scoring_version:['lead scoring version','lead_scoring_version'],
  linkedin_personal:['linkedin personal','linkedin personal url','linkedin profile url','linkedin_profile_url'],
  linkedin_company:['linkedin company','linkedin company url','linkedin_company_url'],
  linkedin_company_id:['linkedin company id','linkedin_company_id'],
  linkedin_employee_count:['linkedin employee count','linkedin_employee_count'],
  linkedin_company_size_band:['linkedin company size band','linkedin_company_size_band','company size band'],
  linkedin_company_description:['linkedin company description','linkedin_company_description'],
  linkedin_company_location:['linkedin company location','linkedin_company_location'],
  linkedin_company_founded_year:['linkedin company founded year','linkedin_company_founded_year'],
  linkedin_match_confidence:['linkedin match confidence','linkedin_match_confidence'],
  linkedin_match_notes:['linkedin match notes','linkedin_match_notes'],
  linkedin_current_title:['linkedin current title','linkedin_current_title'],
  linkedin_profile_location:['linkedin profile location','linkedin_profile_location'],
  signals_summary:['signals summary','signals_summary'],
  estimated_employee_count:['estimated employee count','estimated_employee_count','employee count estimate','employee estimate'],
  employee_count_confidence:['employee count confidence','employee_count_confidence','employee confidence'],
  employee_count_note:['employee count note','employee_count_note','employee count explanation','employee estimate note'],
  growth_signals:['growth signals','growth_signals','growth signal','expansion signals'],
  leadership_signals:['leadership signals','leadership_signals','leadership signal'],
  workforce_pain_signals:['workforce pain signals','workforce_pain_signals','workforce signals','hiring pain signals'],
  engagement_activity_signals:['engagement activity signals','engagement_activity_signals','activity signals','company activity signals'],
  decision_maker_name:['decision maker name','decision_maker_name','decision-maker name'],
  decision_maker_title:['decision maker title','decision_maker_title','decision-maker title'],
  decision_maker_email:['decision maker email','decision_maker_email','decision-maker email'],
  decision_maker_phone:['decision maker phone','decision_maker_phone','decision-maker phone'],
  decision_maker_linkedin:['decision maker linkedin','decision_maker_linkedin','decision-maker linkedin','decision maker linkedin profile'],
  company_linkedin:['company linkedin','company_linkedin','company linkedin page'],
  goall_intelligence_note:['goall intelligence note','goall_intelligence_note','lead intelligence summary','lead intelligence note','caller intelligence summary'],
  recommended_first_call_angle:['recommended first call angle','recommended_first_call_angle','first call angle','opening line'],
  missing_data:['missing data','missing_data','missing data note'],
  partner_type:['partner type','partner_type'],
  organization_size:['organization size','organization_size'],
  potential_reach:['potential reach','potential_reach','estimated reach'],
  partnership_fit_score:['partnership fit score','partnership_fit_score','partner fit score'],
  reason_for_score:['reason for score','reason_for_score','partnership score reason'],
  source_urls:['source urls','source_urls','research sources'],
  date_added:['date added','date_added'],
  signals_positive_count:['signals positive count','signals_positive_count'],
  signals_top_indicators:['signals top indicators','signals_top_indicators'],
  signals_confidence:['signals confidence','signals_confidence'],
  signals_last_checked_at:['signals last checked at','signals_last_checked_at'],
  indicator_type:['indicator type','indicator_type'],
  indicator_direction:['indicator direction','indicator_direction'],
  indicator_confidence:['indicator confidence','indicator_confidence'],
  indicator_summary:['indicator summary','indicator_summary'],
  indicator_source_type:['indicator source type','indicator_source_type'],
  indicator_detected_at:['indicator detected at','indicator_detected_at'],
  indicator_sales_angle:['indicator sales angle','indicator_sales_angle'],
  indicator_requires_attention:['indicator requires attention','indicator_requires_attention'],
  workforce_stability_signal:['workforce stability signal','workforce_stability_signal'],
  layoff_signal_detected:['layoff signal detected','layoff_signal_detected'],
  layoff_signal_confidence:['layoff signal confidence','layoff_signal_confidence'],
  layoff_signal_summary:['layoff signal summary','layoff_signal_summary'],
  leadership_change_detected:['leadership change detected','leadership_change_detected'],
  leadership_change_summary:['leadership change summary','leadership_change_summary'],
  hiring_freeze_signal:['hiring freeze signal','hiring_freeze_signal'],
  review_sentiment_trend:['review sentiment trend','review_sentiment_trend'],
  monitoring_cadence:['monitoring cadence','monitoring_cadence'],
  last_indicator_check_at:['last indicator check at','last_indicator_check_at'],
  indicator_change_detected:['indicator change detected','indicator_change_detected'],
  last_indicator_notification_sent_at:['last indicator notification sent at','last_indicator_notification_sent_at'],
  indicator_notification_suppressed_until:['indicator notification suppressed until','indicator_notification_suppressed_until'],
  account_intelligence_summary:['account intelligence summary','account_intelligence_summary'],
  latest_indicator_update:['latest indicator update','latest_indicator_update'],
  signals_negative_count:['signals negative count','signals_negative_count'],
  enrichment_run_id:['enrichment run id','enrichment_run_id'],
  enrichment_error:['enrichment error','enrichment_error'],
  scraped_annual_revenue:['scraped annual revenue','annual revenue','revenue'],
  scraped_number_of_employees:['scraped number of employees','number of employees','employee count','employees'],
  industry:['industry','raw industry field'],
  title:['title','position','job title'],
  contact_payload:['contact payload','contact_payload'],
  raw_company_signals:['raw company signals','raw_company_signals','raw company signals raw'],
  lead_enrichment_status:['lead enrichment status','enrichment status'],
  enrichment_status:['enrichment status','enrichment_status'],
  call_script_angle:['call script angle','call_script_angle'],
  recommended_outreach_angle:['recommended outreach angle','recommended_outreach_angle'],
  news_count_last_60_days:['news count last 60 days','news_count_last_60_days'],
  ai_company_summary:['ai company summary','ai_company_summary'],
  account_priority_level:['account priority level','account_priority_level'],
  call_script:['call script','call_script'],
  linkedin_notes:['linkedin notes','linkedin_notes'],
  raw_company_context_json:['raw company context json','raw_company_context_json'],
  raw_company_context_result_count:['raw company context result count','raw_company_context_result_count'],
  raw_news_result_count:['raw news result count','raw_news_result_count'],
  raw_linkedin_company_data:['raw linkedin company data','raw_linkedin_company_data'],
  raw_linkedin_personal_data:['raw linkedin personal data','raw_linkedin_personal_data'],
  raw_web_result_count:['raw web result count','raw_web_result_count'],
  raw_company_context_notes:['raw company context notes','raw_company_context_notes'],
  raw_enrichment_notes:['raw enrichment notes','raw_enrichment_notes'],
  linkedin_url:['linkedin url','linkedin URL','linkedin_url'],
  lead_last_processed_at:['lead last processed at','last processed at'],
  raw_web_signals_json:['raw web signals json','web signals'],
  news_raw_last_60_days:['news raw last 60 days','news last 60 days'],
  automation_tag:['automation tag','automationtag'],
  automation_tag_reason:['automation tag reason','automationtagreason'],
  normalized_industry:['normalized industry','normalizedindustry'],
  raw_industry:['raw industry','rawindustry'],
  tag_confidence:['tag confidence','tagconfidence'],
  needs_new_automation:['needs new automation','needsnewautomation'],
  suggested_new_automation_tag:['suggested new automation tag','suggested automation tag','suggestednewautomationtag']
};
function projectSystemPrompt(){
  if(!isBookEditorProject()) return '';
  const projectName = CLIENT_CONFIG.projectName || 'the book project';
  return `
Specialized project mode: Book Editor

You are Michele VAL, the editorial command center for ${CLIENT_CONFIG.clientName}'s memoir, ${projectName}.

You are not a generic assistant. You are a memoir editor, humor editor, psychology-aware reader advocate, IFS-informed prompt reviewer, structural book strategist, and launch thought partner.

This VAL is not being used as a CRM or relationship-management dashboard. Do not default to pipeline, lead, sales, contact, or follow-up language unless the user explicitly asks for launch outreach or book-network support.

The book is generally written and is now in the editing phase. Your job is to help refine the manuscript into a fluid, emotionally layered, page-turning memoir that uses humor, curiosity, compassion, and Internal Family Systems-informed reflection to help readers move through their own transformation.

Preserve Michele's voice. Do not flatten her humor. Do not over-polish the life out of the work. Help each chapter become an invitation, not a directive.

Evaluate chapters for levity, recognition, introspection, self-reflection, compassion, action, IFS prompt quality, transition into the next chapter, reader emotional safety, and narrative momentum.

Humor is not decoration. Humor is a healing doorway. The reader should laugh, lean in, recognize themselves, reflect, and then feel safe enough to act.

Chapter prompts should be clear invitations into embodied action. They should not feel clinical, generic, performative, bossy, or like homework.

Chapters must not feel like separate essays. They should feel like one fluid memoir. If a chapter is in the wrong place, say so. If a transition is weak, say so. If humor is missing, say so. If an IFS prompt feels too clinical, generic, or directive, say so.

When manuscript content is missing, clearly label any examples as demo or sample and never pretend sample material is the actual manuscript.

Your first responsibility is editorial continuity: know where Michele left off, what the next clean editorial move is, where the book needs stronger alignment, and what would most protect the reader's experience and the integrity of the book.
`.trim();
}
function isBookEditorProject(){
  const identity=[
    CLIENT_CONFIG.projectType,
    CLIENT_CONFIG.projectName,
    CLIENT_CONFIG.clientName,
    CLIENT_CONFIG.clientSlug,
    CLIENT_CONFIG.brandName
  ].join(' ').toLowerCase();
  return identity.includes('book_editor') || identity.includes('the big trick') || identity.includes('michele');
}
const OWNER_EMAILS = new Set(String(process.env.VAL_OWNER_EMAILS || process.env.VAL_OWNER_EMAIL || '')
  .split(',')
  .map(e=>e.trim().toLowerCase())
  .filter(Boolean));
const BASE    = 'https://services.leadconnectorhq.com';
const TASKS_FILE = process.env.TASKS_FILE || '/tmp/val_tasks.json';
const STORE_FILE = process.env.VAL_STORE_FILE || '/tmp/val_store.json';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const SESSION_COOKIE = 'val_session';
const VAL_USER_ID = process.env.VAL_USER_ID || CLIENT_CONFIG.clientSlug || 'default';
const MEMORY_CHUNK_SIZE = Number(process.env.MEMORY_CHUNK_SIZE) || 1800;
const MEMORY_CHUNK_OVERLAP = Number(process.env.MEMORY_CHUNK_OVERLAP) || 250;
let pgPool = null;
const ghlMcp = createGhlMcpService({
  baseUrl:BASE,
  fallbackApiKey:GHL_KEY,
  fallbackLocationId:GHL_LOC,
  calendarIds:GHL_CALENDAR_IDS,
  resolveSecret:resolveIntegrationSecret,
  getCurrentUser:currentValUser,
  getTenantId:tenantId,
  inferOwner:inferValOwner,
  logger:console
});

function inferValOwner(obj={}){
  const ids = [
    obj.assignedTo,
    obj.assignedUserId,
    obj.userId,
    obj.ownerId,
    obj.contact?.assignedTo,
    obj.contact?.assignedUserId,
    obj.contact?.userId
  ].filter(Boolean).map(String);
  const raw = [
    obj.assignedTo,
    obj.assignedToName,
    obj.assignedUserName,
    obj.userName,
    obj.ownerName,
    obj.contactOwner,
    obj.user?.name,
    obj.assignedUser?.name,
    obj.contact?.assignedTo,
    obj.contact?.assignedToName,
    obj.contact?.assignedUserName
  ].filter(Boolean).join(' ');
  return raw ? raw.trim() : (ids.length ? 'Assigned user' : '');
}

const demoSessions = new Map();
function demoIso(dayOffset=0,hour=9,minute=0){
  const d=new Date();
  d.setHours(hour,minute,0,0);
  d.setDate(d.getDate()+dayOffset);
  return d.toISOString();
}
function cloneDemo(value){ return JSON.parse(JSON.stringify(value)); }
function demoTemplate(){
  const tasks=[
    {id:'demo-task-1',title:'Send revised scope to Elena',contactName:'Elena Brooks',dueDate:demoIso(0,16,0),notes:'Promise from investor prep. VAL can draft the first-30-days scope and place it in the Approval Queue.',details:[{text:'Created from transcript: Investor Prep With Elena',ts:demoIso(-1,11,20)},{text:'Open loop: make proof of executive adoption easier to understand.',ts:demoIso(-1,11,24)}],completed:false,createdAt:demoIso(-1,11,30)},
    {id:'demo-task-2',title:'Ask Marcus for procurement owner',contactName:'Marcus Chen',dueDate:demoIso(0,13,15),notes:'Needed before the 2 PM enterprise demo. VAL can write the SMS or email and keep the opportunity from stalling.',details:[{text:'Relationship Radar flagged missing decision-maker.',ts:demoIso(0,8,15)},{text:'Marcus said onboarding load and vendor approval are the only remaining friction points.',ts:demoIso(0,8,44)}],completed:false,createdAt:demoIso(0,8,15)},
    {id:'demo-task-3',title:'Review HealthBridge renewal risk',contactName:'Priya Raman',dueDate:demoIso(0,12,30),notes:'Renewal is strong, but implementation notes mention sponsor fatigue. VAL can draft a care-first check-in before any expansion conversation.',details:[{text:'Created from GHL notes and call transcript.',ts:demoIso(-2,15,10)},{text:'Capacity signal: do not push expansion until support strain is acknowledged.',ts:demoIso(-2,15,12)}],completed:false,createdAt:demoIso(-2,15,10)},
    {id:'demo-task-4',title:'Prepare board update bullets',contactName:'Board',dueDate:demoIso(2,9,0),notes:'Use pipeline movement, relationship radar, saved-time outcomes, and the capacity drift warning. VAL can draft the update in an executive format.',details:[{text:'Board wants proof that fewer things are being dropped, not just more activity.',ts:demoIso(-1,9,0)}],completed:false,createdAt:demoIso(-1,9,0)},
    {id:'demo-task-5',title:'Send Jordan the one-paragraph intro ask',contactName:'Jordan Lee',dueDate:demoIso(0,17,0),notes:'Jordan offered a warm path to Northstar. VAL can draft the exact paragraph so the user can approve it quickly.',details:[{text:'Created from retroactive meeting notes.',ts:demoIso(-1,17,2)},{text:'Jordan warned the ask should not sound like a pitch deck.',ts:demoIso(-1,17,4)}],completed:false,createdAt:demoIso(-3,14,20)},
    {id:'demo-task-6',title:'Decide what not to start this week',contactName:'Avery Stone',dueDate:demoIso(0,18,0),notes:'VAL detected capacity drift: five open relationship loops, three active revenue conversations, and two strategic obligations are competing for attention.',details:[{text:'VAL recommendation: close Marcus, Elena, and Jordan before opening any new initiatives.',ts:demoIso(0,8,50)}],completed:false,createdAt:demoIso(0,8,50)}
  ];
  const calendarEvents=[
    {id:'demo-cal-1',title:'Investor Prep With Elena',summary:'Investor Prep With Elena',startTime:demoIso(0,9,30),endTime:demoIso(0,10,15),source:'google',calendarName:'Google Calendar',attendees:[{name:'Elena Brooks',email:'elena@northstarcapital.com'},{name:'Avery Stone',email:'avery@demo.val'}],description:'Review traction, proposal terms, and investor follow-up.',metadata:{transcriptId:'demo-tr-2',notes:['Elena cares about clean adoption proof, not a feature list.','She can influence two portfolio introductions if the first-30-days scope feels credible.']}},
    {id:'demo-cal-2',title:'Enterprise Demo With Marcus',summary:'Enterprise Demo With Marcus',startTime:demoIso(0,14,0),endTime:demoIso(0,15,0),source:'ghl',calendarName:'Sales Calendar',attendees:[{name:'Marcus Chen',email:'marcus@atlasops.com'},{name:'Nina Patel',email:'nina@atlasops.com'}],description:'Atlas Operations wants a workflow demo and buying-process discussion.',metadata:{transcriptId:'demo-tr-3',notes:['Show executive reporting first.','Ask for procurement owner before the call ends.','Keep onboarding light. Nina is watching team load.']}},
    {id:'demo-cal-3',title:'HealthBridge Renewal Review',summary:'HealthBridge Renewal Review',startTime:demoIso(1,11,0),endTime:demoIso(1,11,45),source:'google',calendarName:'Google Calendar',attendees:[{name:'Priya Raman',email:'priya@healthbridge.org'}],description:'Renewal health, implementation load, and expansion potential.',metadata:{transcriptId:'demo-tr-4',notes:['Sponsor is still positive. Team strain is the actual risk.','Lead with care and operational support before expansion.']}},
    {id:'demo-cal-4',title:'Retro Partnership Notes',summary:'Retro Partnership Notes',startTime:demoIso(-1,16,30),endTime:demoIso(-1,17,0),source:'val',calendarName:'VAL Retroactive Meetings',attendees:[{name:'Jordan Lee',email:'jordan@fieldstone.co'}],metadata:{retroactive:true,transcriptId:'demo-tr-1',notes:['Retroactive event created because the transcript arrived without a calendar match.','Jordan offered a warm intro if the ask stays concise.']}},
    {id:'demo-cal-5',title:'Capacity Reset Block',summary:'Capacity Reset Block',startTime:demoIso(0,15,30),endTime:demoIso(0,16,0),source:'val',calendarName:'VAL Operating Rhythm',attendees:[{name:'Avery Stone',email:'avery@demo.val'}],description:'VAL protected this block because the morning created too many open loops.',metadata:{notes:['Review what can be delegated.','Do not add a new initiative today unless one open promise closes first.']}}
  ];
  const opportunities=[
    {id:'demo-opp-1',name:'Atlas Operations Pilot',status:'open',stage:'Proposal Review',value:48000,contactName:'Marcus Chen',contactId:'demo-contact-1',contactEmail:'marcus@atlasops.com',contactPhone:'555-0147',owner:'Avery Stone',updatedAt:demoIso(-3,12,0),daysInStage:9,stalled:false,notes:['Marcus liked the automation demo but needs procurement owner confirmed.','Nina asked about onboarding load and executive reporting.','Next best move: send a 3-point pilot memo and ask who signs vendor approval.','VAL can draft the memo and create the procurement-owner task.']},
    {id:'demo-opp-2',name:'Northstar Capital Advisory',status:'open',stage:'Warm Intro',value:85000,contactName:'Elena Brooks',contactId:'demo-contact-2',contactEmail:'elena@northstarcapital.com',contactPhone:'555-0188',owner:'Avery Stone',updatedAt:demoIso(-1,15,0),daysInStage:2,stalled:false,notes:['Elena requested a tighter scope and proof of executive adoption.','She mentioned two portfolio founders who may need VAL.','VAL can draft the revised scope and a separate referral note.']},
    {id:'demo-opp-3',name:'HealthBridge Expansion',status:'open',stage:'Renewal Risk',value:32000,contactName:'Priya Raman',contactId:'demo-contact-3',contactEmail:'priya@healthbridge.org',contactPhone:'555-0191',owner:'Avery Stone',updatedAt:demoIso(-20,10,0),daysInStage:20,stalled:true,notes:['Implementation team feels stretched. Sponsor still values the outcome.','Do not push expansion until support load is acknowledged.','VAL recommends a care-first follow-up and a task to revisit expansion after support stabilizes.']},
    {id:'demo-opp-4',name:'Fieldstone Partner Channel',status:'open',stage:'Discovery',value:120000,contactName:'Jordan Lee',contactId:'demo-contact-4',contactEmail:'jordan@fieldstone.co',contactPhone:'555-0128',owner:'Avery Stone',updatedAt:demoIso(-8,9,0),daysInStage:8,stalled:false,notes:['Jordan can introduce VAL to three operating partners. Needs a crisp referral ask.','VAL can write the intro paragraph and queue it for approval.']}
  ];
  const conversations=[
    {id:'demo-conv-1',contactName:'Marcus Chen',contactId:'demo-contact-1',unread:3,unreadCount:3,lastMessage:'Can you send the pilot memo before our 2 PM call?',lastMessageBody:'Can you send the pilot memo before our 2 PM call?',type:'sms',source:'ghl'},
    {id:'demo-conv-2',contactName:'Elena Brooks',contactId:'demo-contact-2',unread:1,unreadCount:1,lastMessage:'The scope looks close. Can you make the first 30 days clearer?',lastMessageBody:'The scope looks close. Can you make the first 30 days clearer?',type:'email',source:'ghl'},
    {id:'demo-conv-3',contactName:'Jordan Lee',contactId:'demo-contact-4',unread:2,unreadCount:2,lastMessage:'Happy to intro you, just send me the tight version.',lastMessageBody:'Happy to intro you, just send me the tight version.',type:'email',source:'ghl'}
  ];
  const messages={
    'demo-conv-1':[
      {id:'m1',direction:'inbound',from:'Marcus Chen',body:'Can you send the pilot memo before our 2 PM call?',dateAdded:demoIso(0,8,42),type:'sms'},
      {id:'m2',direction:'inbound',from:'Marcus Chen',body:'Main question from my side is who owns procurement and how heavy onboarding gets.',dateAdded:demoIso(0,8,44),type:'sms'}
    ],
    'demo-conv-2':[
      {id:'m3',direction:'inbound',from:'Elena Brooks',body:'The scope looks close. Can you make the first 30 days clearer?',dateAdded:demoIso(0,7,58),type:'email'}
    ],
    'demo-conv-3':[
      {id:'m4',direction:'inbound',from:'Jordan Lee',body:'Happy to intro you, just send me the tight version.',dateAdded:demoIso(-1,17,12),type:'email'},
      {id:'m5',direction:'inbound',from:'Jordan Lee',body:'The ask should be one paragraph max.',dateAdded:demoIso(-1,17,13),type:'email'}
    ]
  };
  const drafts=[
    {id:'demo-draft-1',userId:'demo-user',tenantId:'demo-val',draftType:'follow_up',contactId:'demo-contact-2',provider:'internal',subject:'Revised VAL scope',body:'Elena,\n\nI tightened the first 30 days into three phases: context capture, operating rhythm, and executive visibility.\n\nThe main outcome is simple: fewer dropped promises, cleaner follow-through, and a leadership layer that keeps momentum visible.\n\nAvery',status:'draft',sourceContext:{source:'demo'},createdAt:demoIso(0,8,25),updatedAt:demoIso(0,8,25)},
    {id:'demo-draft-2',userId:'demo-user',tenantId:'demo-val',draftType:'email_reply',contactId:'demo-contact-1',provider:'internal',subject:'Pilot memo for today',body:'Marcus,\n\nHere is the short version for today: VAL can start with the two highest-friction workflows, show measurable follow-up capture, and keep onboarding light enough that your team does not need another system to manage.\n\nBefore we wrap today, I would also like to confirm who owns vendor approval so we can keep this from slowing down after the demo.\n\nAvery',status:'draft',sourceContext:{source:'demo'},createdAt:demoIso(0,8,40),updatedAt:demoIso(0,8,40)},
    {id:'demo-draft-3',userId:'demo-user',tenantId:'demo-val',draftType:'relationship_outreach',contactId:'demo-contact-4',provider:'internal',subject:'Tight intro language',body:'Jordan,\n\nHere is the tight version you asked for:\n\nAvery built VAL for leaders whose relationships, meetings, and follow-through directly affect revenue. It listens across conversations, remembers commitments, prepares the next move, and keeps important people from falling through the cracks.\n\nIf someone in your network is constantly carrying too many high-value conversations at once, they are probably the right fit.\n\nAvery',status:'draft',sourceContext:{source:'demo'},createdAt:demoIso(-1,17,20),updatedAt:demoIso(-1,17,20)},
    {id:'demo-draft-4',userId:'demo-user',tenantId:'demo-val',draftType:'renewal_checkin',contactId:'demo-contact-3',provider:'internal',subject:'Checking in before renewal review',body:'Priya,\n\nBefore we talk renewal, I want to acknowledge the implementation load your team has been carrying.\n\nI do not want to add pressure to a team that is already stretched. My first priority for tomorrow is to understand what needs to be simplified or supported so the value stays useful instead of becoming one more thing to manage.\n\nAvery',status:'draft',sourceContext:{source:'demo'},createdAt:demoIso(0,8,55),updatedAt:demoIso(0,8,55)}
  ];
  const emails=[
    {provider:'gmail',messageId:'demo-email-1',threadId:'demo-thread-1',subject:'Pilot memo before 2 PM',from:{name:'Marcus Chen',email:'marcus@atlasops.com'},snippet:'Can you send the pilot memo before our 2 PM call?',bodyPreview:'Can you send the pilot memo before our 2 PM call? Procurement and onboarding are the main questions.',classification:'needs_reply',confidence:'high',reason:'Time-sensitive meeting prep and a direct request.',recommendedAction:'Draft reply',matchedContact:{name:'Marcus Chen'}},
    {provider:'gmail',messageId:'demo-email-2',threadId:'demo-thread-2',subject:'Scope clarification',from:{name:'Elena Brooks',email:'elena@northstarcapital.com'},snippet:'Can you make the first 30 days clearer?',bodyPreview:'The scope looks close. Can you make the first 30 days clearer?',classification:'needs_reply',confidence:'high',reason:'Active opportunity, asks for revision.',recommendedAction:'Draft reply',matchedContact:{name:'Elena Brooks'}},
    {provider:'outlook',messageId:'demo-email-3',threadId:'demo-thread-3',subject:'Intro language',from:{name:'Jordan Lee',email:'jordan@fieldstone.co'},snippet:'Happy to intro you, just send me the tight version.',bodyPreview:'Happy to intro you, just send me the tight version. The ask should be one paragraph max.',classification:'needs_attention',confidence:'high',reason:'Warm intro opportunity that could go stale.',recommendedAction:'Create outreach draft',matchedContact:{name:'Jordan Lee'}},
    {provider:'gmail',messageId:'demo-email-4',threadId:'demo-thread-4',subject:'Following up on renewal',from:{name:'Priya Raman',email:'priya@healthbridge.org'},snippet:'Let’s revisit after the internal support conversation.',bodyPreview:'Let’s revisit after the internal support conversation.',classification:'waiting_on_response',confidence:'medium',reason:'Renewal risk and delayed internal conversation.',recommendedAction:'Track follow-up',matchedContact:{name:'Priya Raman'}}
  ];
  const transcripts=[
    {id:'demo-tr-1',type:'processed_transcript',title:'Retro Partnership Notes',rawText:'Jordan offered to introduce Avery to three operating partners if Avery sends a concise one-paragraph referral ask. Jordan emphasized that the ask should not sound like a pitch deck. Action item: send tight intro language. VAL created a retroactive calendar event because the transcript arrived without a natural appointment match.',metadata:{source:'demo',meetingId:'demo-cal-4',contactName:'Jordan Lee',summary:'Warm intro offer with a narrow follow-up window.'},createdAt:demoIso(-1,17,0)},
    {id:'demo-tr-2',type:'processed_transcript',title:'Investor Prep With Elena',rawText:'Elena asked for the first 30 days to be clearer. She liked the executive visibility angle but said investors will want proof that adoption happens without adding administrative burden. She mentioned two portfolio founders who may be strong introductions if the scope feels mature. Action item: send revised scope by 4 PM.',metadata:{source:'demo',meetingId:'demo-cal-1',contactName:'Elena Brooks',summary:'Scope revision and portfolio referral opportunity.'},createdAt:demoIso(-1,11,20)},
    {id:'demo-tr-3',type:'processed_transcript',title:'Enterprise Demo With Marcus',rawText:'Marcus said the Atlas team is close if the pilot can show value without heavy onboarding. Nina asked how executive reporting works and who maintains the workflow. The buying process is unclear because procurement owner has not been named. Action item: send pilot memo and ask Marcus who owns vendor approval.',metadata:{source:'demo',meetingId:'demo-cal-2',contactName:'Marcus Chen',summary:'Procurement owner and onboarding load are the deal risks.'},createdAt:demoIso(0,8,44)},
    {id:'demo-tr-4',type:'processed_transcript',title:'HealthBridge Renewal Review',rawText:'Priya still values VAL, but her team is tired. The renewal risk is not lack of belief. It is implementation fatigue. She responded best when the conversation shifted from expansion to relief. Action item: draft a care-first check-in and schedule a later expansion conversation only after support load is stabilized.',metadata:{source:'demo',meetingId:'demo-cal-3',contactName:'Priya Raman',summary:'Renewal requires nervous-system-aware handling and no pressure.'},createdAt:demoIso(-2,15,10)},
    {id:'demo-tr-5',type:'processed_transcript',title:'Morning Operating Review',rawText:'VAL reviewed the week and detected capacity drift. There are five open relationship loops, three active revenue conversations, two strategic commitments, and too many small follow-up promises. Recommendation: close Marcus, Elena, and Jordan before opening any new initiative. Delegate board-update formatting and protect a 30-minute recovery block.',metadata:{source:'demo',contactName:'Avery Stone',summary:'Capacity drift detected from commitments expanding faster than closure.'},createdAt:demoIso(0,8,50)}
  ];
  const relationships=[
    {name:'Marcus Chen',email:'marcus@atlasops.com',score:94,priority:'high',recommendedAction:'Send pilot memo before the 2 PM demo and ask who owns procurement.',reason:'High-value active opportunity, time-sensitive meeting, direct request sitting unread.',why:'High-value active opportunity, time-sensitive meeting, direct request sitting unread.',lastInteraction:demoIso(0,8,44),lastInteractionAt:demoIso(0,8,44),tags:['revenue','urgent','procurement'],openLoops:['Pilot memo','Procurement owner','Onboarding concern'],opportunitySignals:['48K pilot in proposal review','Nina is watching implementation load'],evidence:[{type:'email',summary:'Asked for pilot memo before 2 PM.',date:demoIso(0,8,42),confidence:'high'},{type:'transcript',summary:'Procurement owner and onboarding load are deal risks.',date:demoIso(0,8,44),confidence:'high'},{type:'opportunity',summary:'Atlas Operations Pilot in Proposal Review.',date:demoIso(-3,12,0),confidence:'high'}],draftOutreach:{subject:'Pilot memo for today',body:'Marcus,\n\nHere is the concise pilot path for today. We start with the two highest-friction workflows, keep onboarding light, and give your leadership team visibility into follow-through without adding another system for the team to babysit.\n\nOne thing I want to clarify before the call ends: who owns vendor approval on your side?\n\nAvery'},profile:{name:'Marcus Chen',summary:'Marcus is the most time-sensitive revenue relationship in the demo. He is close, but the deal can stall if procurement ownership stays vague.',riskPattern:'Deal drift through unclear owner.',nextBestMove:'Send the pilot memo and ask directly who owns vendor approval.',valCanDo:['Draft the memo','Create the procurement task','Prep the 2 PM meeting','Update opportunity notes after the call']}},
    {name:'Elena Brooks',email:'elena@northstarcapital.com',score:89,priority:'high',recommendedAction:'Send the revised first-30-days scope.',reason:'Investor-adjacent relationship with two possible portfolio referrals.',why:'Investor-adjacent relationship with two possible portfolio referrals.',lastInteraction:demoIso(0,7,58),lastInteractionAt:demoIso(0,7,58),tags:['influence','referral','scope'],openLoops:['Revised scope','Portfolio founder referrals','Proof of adoption'],opportunitySignals:['85K advisory opportunity','Two potential founder introductions'],evidence:[{type:'meeting',summary:'Investor prep today.',date:demoIso(0,9,30),confidence:'high'},{type:'transcript',summary:'Elena wants a clearer first 30 days and proof of adoption.',date:demoIso(-1,11,20),confidence:'high'},{type:'draft',summary:'Draft waiting in approval queue.',date:demoIso(0,8,25),confidence:'high'}],draftOutreach:{subject:'Revised VAL scope',body:'Elena,\n\nI tightened the first 30 days into three phases: context capture, operating rhythm, and executive visibility.\n\nThe point is not more tooling. It is fewer dropped promises, cleaner follow-through, and a leadership layer that makes adoption visible without adding administrative weight.\n\nAvery'},profile:{name:'Elena Brooks',summary:'Elena can become both a client and a referral channel if the scope feels credible and restrained.',riskPattern:'Overexplaining could weaken confidence.',nextBestMove:'Send the revised scope today and keep it plain.',valCanDo:['Draft the revised scope','Create a referral follow-up task','Prep the investor conversation','Track the two possible founder intros']}},
    {name:'Priya Raman',email:'priya@healthbridge.org',score:76,priority:'medium',recommendedAction:'Acknowledge implementation fatigue before discussing expansion.',reason:'Renewal value is real, but sponsor fatigue is showing in notes.',why:'Renewal value is real, but sponsor fatigue is showing in notes.',lastInteraction:demoIso(-2,15,10),lastInteractionAt:demoIso(-2,15,10),tags:['renewal','care-first','capacity'],openLoops:['Renewal risk','Support load','Expansion timing'],opportunitySignals:['32K expansion possible after stabilization','Sponsor still values VAL'],evidence:[{type:'note',summary:'Implementation team feels stretched.',date:demoIso(-2,15,10),confidence:'high'},{type:'transcript',summary:'Risk is implementation fatigue, not lack of belief.',date:demoIso(-2,15,10),confidence:'high'}],draftOutreach:{subject:'Checking in before renewal review',body:'Priya,\n\nBefore we talk renewal, I want to acknowledge the implementation load your team has been carrying.\n\nMy first priority is to understand what needs to be simplified or supported so the value stays useful instead of becoming one more thing to manage.\n\nAvery'},profile:{name:'Priya Raman',summary:'Priya is a trust-sensitive renewal relationship. Expansion should wait until the team feels supported.',riskPattern:'Pushing growth before relief could reduce trust.',nextBestMove:'Send a care-first check-in and keep expansion out of the first conversation.',valCanDo:['Draft the check-in','Create a renewal risk task','Prep the renewal review','Summarize support themes']}},
    {name:'Jordan Lee',email:'jordan@fieldstone.co',score:84,priority:'high',recommendedAction:'Send one-paragraph referral ask today.',reason:'Warm intro offer is fresh and easy to lose if delayed.',why:'Warm intro offer is fresh and easy to lose if delayed.',lastInteraction:demoIso(-1,17,13),lastInteractionAt:demoIso(-1,17,13),tags:['intro','partner','momentum'],openLoops:['Intro language','Three operating partners','Follow-up window'],opportunitySignals:['120K partner-channel opportunity','Three warm introductions possible'],evidence:[{type:'transcript',summary:'Jordan offered three operating partner introductions.',date:demoIso(-1,17,0),confidence:'high'},{type:'message',summary:'The ask should be one paragraph max.',date:demoIso(-1,17,13),confidence:'high'}],draftOutreach:{subject:'Tight intro language',body:'Jordan,\n\nHere is the tight version you asked for:\n\nAvery built VAL for leaders whose relationships, meetings, and follow-through directly affect revenue. It listens across conversations, remembers commitments, prepares the next move, and keeps important people from falling through the cracks.\n\nIf someone in your network is constantly carrying too many high-value conversations at once, they are probably the right fit.\n\nAvery'},profile:{name:'Jordan Lee',summary:'Jordan is a momentum-sensitive partner relationship. The value is high, but only if the ask stays crisp.',riskPattern:'Delay turns a warm intro into a forgotten nice idea.',nextBestMove:'Send the one-paragraph intro ask today.',valCanDo:['Draft the intro ask','Create follow-up tasks for each intro','Brainstorm partner value adds','Track the intro path']}},
    {name:'Renee Wallace',email:'renee@northlinebenefits.com',score:62,priority:'watch',recommendedAction:'Reconnect next week with a simple value-add, not a sales ask.',reason:'Strong network fit, but no current open promise. Useful to nurture without adding pressure today.',why:'Strong network fit, but no current open promise. Useful to nurture without adding pressure today.',lastInteraction:demoIso(-18,10,30),lastInteractionAt:demoIso(-18,10,30),tags:['cooling','network','benefits'],openLoops:['No outreach in 18 days'],opportunitySignals:['Relationship-heavy renewal business','Could benefit from follow-up discipline'],evidence:[{type:'relationship',summary:'No recent outreach in the last two weeks.',date:demoIso(-18,10,30),confidence:'medium'}],draftOutreach:{subject:'Quick thought for your renewal season',body:'Renee,\n\nI had a quick thought after our last conversation. Renewal season seems like exactly the kind of stretch where small dropped promises create outsized friction.\n\nIf useful, I can send you a simple way to map the conversations that most need follow-through.\n\nAvery'},profile:{name:'Renee Wallace',summary:'Renee is a cooling relationship worth nurturing, but not more urgent than today’s revenue loops.',riskPattern:'Could be over-prioritized if the user is avoiding harder open promises.',nextBestMove:'Snooze until next week unless today’s top three loops are closed.',valCanDo:['Draft a light nurture email','Snooze the relationship','Create a next-week follow-up']}}
  ];
  const memoryItems=[
    {id:'demo-memory-1',kind:'capacity_signal',summary:'Capacity drift detected from open loops expanding faster than closure.',rawText:'Five relationship loops, three revenue conversations, two strategic obligations, and several small follow-up promises are active at once. Close Marcus, Elena, and Jordan before opening anything new.',importance:4,createdAt:demoIso(0,8,50),metadata:{source:'demo'}},
    {id:'demo-memory-2',kind:'operating_preference',summary:'Avery works best with direct recommendations and short approval queues.',rawText:'The user prefers VAL to draft or queue next actions instead of explaining every option. They need clear, calm pressure without overload.',importance:4,createdAt:demoIso(-5,9,0),metadata:{source:'demo'}}
  ];
  return {tasks,calendarEvents,opportunities,conversations,messages,drafts,emails,transcripts,relationships,memoryItems,createdAt:new Date().toISOString()};
}
function demoSessionId(req,res){
  const existing=parseCookies(req).val_demo_session;
  const id=existing || crypto.randomBytes(12).toString('hex');
  if(!existing) res.cookie('val_demo_session',id,{httpOnly:true,sameSite:'lax',secure:false,maxAge:60*60*1000});
  return id;
}
function demoState(req,res){
  const id=demoSessionId(req,res);
  if(!demoSessions.has(id)) demoSessions.set(id,cloneDemo(demoTemplate()));
  return demoSessions.get(id);
}
function resetDemoState(req,res){
  const id=demoSessionId(req,res);
  const state=cloneDemo(demoTemplate());
  demoSessions.set(id,state);
  return state;
}
function demoUser(){
  return {id:'demo-user',email:'demo@graceintelligence.com',name:'Demo User',role:'demo'};
}
function withDemoCta(text){
  const copy=String(text||'');
  return copy.includes(VAL_SIGNUP_URL) ? copy : `${copy}\n\nReady to make this yours? Get your VAL now: ${VAL_SIGNUP_URL}`;
}
function demoLeads(body={}){
  const type=String(body.organizationType||body.criteria||'growth companies').replace(/\s+/g,' ').trim();
  const market=String(body.market||body.location||'United States').trim();
  const limit=Math.min(Math.max(Number(body.limit)||6,1),12);
  return [
    {organizationName:'Beacon Field Services',website:'https://example.com/beacon',industry:'Field Operations',primaryService:'Multi-site service operations',location:market,organizationType:type,partnerFit:'Strong',approximateDonors:640,donorEstimateBasis:'Public team pages, hiring posts, multi-location signals',evidenceSignals:['Active hiring','Multiple locations','Visible operations team'],decisionMakerName:'Dana Holt',decisionMakerTitle:'COO',email:'dana.holt@example.com',phone:'555-0201',linkedinPersonalUrl:'https://linkedin.com/in/demo-dana-holt',linkedinCompanyUrl:'https://linkedin.com/company/demo-beacon',hiringActivity:'Yes, operations and customer success roles',careersPage:'Yes',growthActivity:'Expansion into two new markets',operationalActivity:'Dispatch, service teams, account management',operationalIndicators:'Multi-location, recurring client operations',googleRaw:'4.6 rating, 128 reviews, active listing',newsRaw:'Recent market expansion announcement',nextOutreachAngle:'Operational visibility and follow-through at scale',confidence:'high',rocketReachStatus:'verified demo email'},
    {organizationName:'Atlas People Systems',website:'https://example.com/atlas-people',industry:'Workforce Services',primaryService:'HR and operations support',location:market,organizationType:type,partnerFit:'Strong',approximateDonors:420,donorEstimateBasis:'Hiring volume, leadership page, service footprint',evidenceSignals:['Leadership team visible','Hiring posts','Enterprise service model'],decisionMakerName:'Marcus Chen',decisionMakerTitle:'VP Operations',email:'marcus.chen@example.com',phone:'555-0202',linkedinPersonalUrl:'https://linkedin.com/in/demo-marcus-chen',linkedinCompanyUrl:'https://linkedin.com/company/demo-atlas-people',hiringActivity:'Yes',careersPage:'Yes',growthActivity:'New enterprise accounts',operationalActivity:'Client delivery pods and support teams',operationalIndicators:'CRM-heavy, recurring delivery, cross-functional follow-up',googleRaw:'Active website and company listing',newsRaw:'No recent news found',nextOutreachAngle:'Reduce dropped follow-up across account teams',confidence:'high',rocketReachStatus:'verified demo email'},
    {organizationName:'Northline Benefits Group',website:'https://example.com/northline',industry:'Benefits Advisory',primaryService:'Employer benefits and advisory services',location:market,organizationType:type,partnerFit:'Moderate',approximateDonors:310,donorEstimateBasis:'Team page and LinkedIn size indicators',evidenceSignals:['Professional services team','Multiple advisors','Client onboarding complexity'],decisionMakerName:'Renee Wallace',decisionMakerTitle:'Founder',email:'renee.wallace@example.com',phone:'555-0203',linkedinPersonalUrl:'https://linkedin.com/in/demo-renee-wallace',linkedinCompanyUrl:'https://linkedin.com/company/demo-northline',hiringActivity:'Unclear',careersPage:'No',growthActivity:'Client growth signals on website',operationalActivity:'Advisor follow-up and renewal cycles',operationalIndicators:'Relationship-heavy, renewal-sensitive',googleRaw:'Business listing found',newsRaw:'No recent news found',nextOutreachAngle:'Protect renewal conversations and owner promises',confidence:'medium',rocketReachStatus:'verified demo email'}
  ].slice(0,limit).map((lead,i)=>({...lead,organizationName:i>2?`${lead.organizationName} ${i+1}`:lead.organizationName}));
}
function demoLeadDiscovery(body={}){
  const market=String(body.market||body.location||'United States');
  const organizationType=String(body.organizationType||'growth companies');
  const employeeMinimum=donorValue(body.employeeMinimum)||300;
  const tag=normalizeLeadTag(body.tag||organizationType);
  const leads=demoLeads(body);
  return {ok:true,market,criteria:String(body.criteria||`${organizationType} with at least ${employeeMinimum} employees`),organizationType,employeeMinimum,tag,scraped:{configured:true,rawCount:leads.length,demo:true},rocketReachMode:'review',leads};
}
function demoRelationshipReview(state,windowDays=7){
  const relationships=cloneDemo(state.relationships||[]);
  const urgent=relationships.filter(r=>['high','urgent'].includes(String(r.priority||'').toLowerCase()));
  const cooling=relationships.filter(r=>String(r.priority||'').toLowerCase()==='watch'||String(r.tags||'').includes('cooling'));
  const momentum=relationships.filter(r=>String(r.tags||'').includes('intro')||String(r.tags||'').includes('referral')||String(r.tags||'').includes('revenue'));
  const hiddenOpportunities=(state.opportunities||[]).map(o=>({
    id:o.id,
    name:o.contactName,
    email:o.contactEmail,
    opportunityName:o.name,
    value:o.value,
    stage:o.stage,
    reason:(o.notes||[]).slice(-1)[0]||'Opportunity needs a clear next step.',
    recommendedAction:o.stalled?'Stabilize trust before expansion.':'Create the next concrete ask and queue the follow-up.',
    evidence:(o.notes||[]).map(n=>({type:'opportunity_note',summary:n,confidence:'high'})),
    draftOutreach:{subject:`Next step for ${o.name}`,body:`${o.contactName},\n\nI want to keep this simple and useful. The next best step I see is to clarify the owner, reduce any operational friction, and make the follow-through easy for your team.\n\nAvery`}
  }));
  const draftCommunications=(state.drafts||[]).map(d=>({
    id:d.id,
    contactName:(relationships.find(r=>d.contactId&&String(d.contactId).includes(String((r.email||'').split('@')[0]||'')))||{}).name || d.contactId || 'Relationship',
    subject:d.subject,
    body:d.body,
    status:d.status,
    recommendedAction:'Review, edit if needed, then approve.'
  }));
  return {
    ok:true,
    demo:true,
    windowDays,
    total:relationships.length,
    summary:{
      needsNurture:cooling.length,
      atRisk:1,
      hiddenOpportunity:hiddenOpportunities.length,
      draftsWaiting:(state.drafts||[]).length,
      capacityDrift:true
    },
    capacitySignal:{
      level:'moderate',
      title:'Capacity drift detected',
      message:'There are more open promises than clean closures right now. VAL recommends finishing Marcus, Elena, and Jordan before starting a new initiative.',
      recommendedAction:'Close three open loops, then review what can be delegated.'
    },
    relationshipProfiles:relationships.map(r=>({
      ...r.profile,
      name:r.name,
      email:r.email,
      score:r.score,
      priority:r.priority,
      openLoops:r.openLoops||[],
      evidence:r.evidence||[],
      recommendedAction:r.recommendedAction,
      draftOutreach:r.draftOutreach
    })),
    topRelationshipPriorities:urgent.slice(0,4),
    highestLeverageRelationships:relationships.filter(r=>Number(r.score)>=80),
    coolingRelationships:cooling,
    momentumRelationships:momentum,
    peopleNotContactedRecently:cooling,
    forgottenCommitments:(state.tasks||[]).filter(t=>!t.completed).slice(0,6).map(t=>({
      name:t.contactName||'Open commitment',
      score:80,
      priority:'commitment',
      reason:t.notes||'Open task from a prior conversation.',
      recommendedAction:t.title,
      openLoops:[t.title],
      evidence:(t.details||[]).map(d=>({type:'task_detail',summary:d.text,confidence:'high'})),
      draftOutreach:{subject:t.title,body:`I want to close the loop on this: ${t.title}.`}
    })),
    hiddenOpportunities,
    suggestedIntroductions:[
      {name:'Jordan Lee',email:'jordan@fieldstone.co',score:84,priority:'high',reason:'Jordan can introduce three operating partners if the ask stays concise.',recommendedAction:'Send the one-paragraph intro ask today.',openLoops:['Intro language'],evidence:[{type:'transcript',summary:'Jordan offered three operating partner introductions.',confidence:'high'}],draftOutreach:relationships.find(r=>r.name==='Jordan Lee')?.draftOutreach},
      {name:'Elena Brooks',email:'elena@northstarcapital.com',score:89,priority:'high',reason:'Elena mentioned two portfolio founders who could become strong VAL prospects.',recommendedAction:'Send revised scope first, then ask which founder would benefit most.',openLoops:['Revised scope','Founder referrals'],evidence:[{type:'transcript',summary:'Two possible portfolio introductions.',confidence:'high'}],draftOutreach:relationships.find(r=>r.name==='Elena Brooks')?.draftOutreach}
    ],
    relationshipTaskPriorities:(state.tasks||[]).filter(t=>!t.completed).slice(0,5),
    draftCommunications,
    priorityReviewIntegration:{
      first:'Marcus Chen',
      order:['Marcus Chen','Elena Brooks','Jordan Lee','Priya Raman'],
      reason:'This order protects revenue, influence, warm-intro momentum, and renewal trust without overloading the day.'
    },
    askForAssistance:[
      'Draft Marcus pilot memo',
      'Create procurement-owner task',
      'Prep Elena scope conversation',
      'Write Jordan intro ask',
      'Draft Priya care-first renewal check-in'
    ],
    highestPriority:urgent.slice(0,3),
    relationships,
    recommendedNextAction:urgent[0]?.recommendedAction||'Start with the highest-priority relationship.'
  };
}
function demoMeetingBriefingResponse(state,meeting){
  const attendees=inferAttendeesFromEvent(meeting);
  const nameText=attendees.map(a=>a.name||a.email).join(', ') || 'attendees unclear';
  const searchText=[meeting.id,meeting.title,meeting.summary,nameText].filter(Boolean).join(' ').toLowerCase();
  const relatedTasks=(state.tasks||[]).filter(t=>!t.completed&&[t.contactName,t.title].some(v=>v&&searchText.includes(String(v).toLowerCase()))).slice(0,4);
  const transcriptContext=(state.transcripts||[]).filter(t=>{
    const meta=t.metadata||{};
    return meta.meetingId===meeting.id || [t.title,meta.contactName,meta.summary].some(v=>v&&searchText.includes(String(v).toLowerCase()));
  }).slice(0,4);
  const meetingNotes=Array.isArray(meeting.metadata?.notes)?meeting.metadata.notes:[];
  const briefing=[
    `What matters: ${meeting.title||'This meeting'} is not just a calendar item. It is tied to a relationship, an open promise, or a revenue path.`,
    `Attendees: ${nameText}.`,
    transcriptContext.length?`Saved notes and transcript context: ${transcriptContext.map(t=>t.metadata?.summary||t.rawText||t.title).join(' ')}`:'',
    meetingNotes.length?`Meeting notes: ${meetingNotes.join(' ')}`:'',
    relatedTasks.length?`Open loops: ${relatedTasks.map(t=>t.title).join('; ')}.`:'Open loops: listen for the next owner, deadline, and follow-up promise.',
    'Capacity check: do not create more motion than you can close. Leave with one owner, one next step, and one written follow-up.',
    'VAL can help after this call by drafting the recap, creating tasks, updating relationship context, and keeping the opportunity visible.'
  ].filter(Boolean).join('\n\n');
  return {ok:true,meeting:{...meeting,attendees},gmailContext:(state.emails||[]).slice(0,3),transcriptContext,taskContext:relatedTasks,memoryContext:(state.memoryItems||[]).map(m=>m.summary),contactNotes:meetingNotes.map(n=>({summary:n})),briefing,openLoops:relatedTasks.map(t=>t.title),suggestedQuestions:['What would make this a clear win by the end of the call?','Who owns the next step?','What should I send after we hang up?'],recommendedFollowUps:['Draft concise recap','Create next-step task','Update opportunity notes','Queue relationship follow-up']};
}
function demoIntelligenceResponse(action,query,state){
  const review=demoRelationshipReview(state,7);
  const base=`Recommended next move: ${review.recommendedNextAction}\n\nCapacity drift is already visible. VAL would close the Marcus pilot memo, Elena scope revision, and Jordan intro ask before letting the day expand. That protects revenue and trust without making the user carry every thread manually.`;
  const map={
    executive_review:`Executive review: the issue is not lack of opportunity. It is too many open promises competing for the same attention.\n\nHighest leverage order:\n1. Marcus pilot memo and procurement owner.\n2. Elena first-30-days scope.\n3. Jordan one-paragraph intro ask.\n4. Priya renewal check-in with care first.\n\nVAL can draft all four, queue them for approval, and create the task list so the user only decides instead of rebuilding context.`,
    relationship_radar:`Relationship Radar: Marcus, Elena, Jordan, and Priya matter for different reasons.\n\nMarcus is revenue-sensitive. Elena is influence-sensitive. Jordan is momentum-sensitive. Priya is trust-sensitive.\n\nThe quiet risk is Renee. She has cooled for 18 days, but VAL would snooze her until the urgent promises are closed. That is the capacity-protective move.`,
    task_priorities:`Task priorities are not equal.\n\nFirst: send Marcus the pilot memo.\nSecond: send Elena the revised scope.\nThird: send Jordan the intro ask.\nFourth: send Priya a care-first renewal note.\n\nVAL can write the emails, create the tasks, and keep each commitment tied to the right contact.`,
    saved_time:`Saved-time suggestion: use the time VAL gives back for one high-impact executive move, not another pile of small work.\n\nToday that means 30 minutes on the board narrative: what changed, what is still at risk, and what needs executive attention. VAL can draft the first version from pipeline and relationship context.`,
    follow_up:`Follow-up queue: VAL already has four useful drafts waiting. The point is not to write from scratch. The user should review, approve, and move on.\n\nThe most important follow-up is Marcus because it affects today. Jordan is second because warm intros cool quickly.`
  };
  const key=/relationship|radar/i.test(action)?'relationship_radar':/review/i.test(action)?'executive_review':/task|priority/i.test(action)?'task_priorities':/saved|time/i.test(action)?'saved_time':/follow|draft/i.test(action)?'follow_up':'';
  return withDemoCta(map[key]||base);
}
function demoChatResponse(lastUser,state){
  const q=String(lastUser||'').toLowerCase();
  if(/ghostwriting social media content|social media post|write a .* post|platform guidelines/i.test(String(lastUser||''))){
    return [
      'The part of leadership no one warns you about is how many important things become invisible.',
      '',
      'The meeting note you meant to revisit.',
      'The relationship that went quiet.',
      'The follow-up that mattered, but got buried under the next urgent thing.',
      '',
      'That is the work VAL is built for.',
      '',
      'Not to make executives busier. To help them close the loops that protect trust, revenue, and momentum.',
      '',
      'In today\'s demo, VAL is watching the commitments, meetings, transcripts, emails, pipeline movement, and relationship signals. Then it turns the mess into the next usable action: draft this, prep that meeting, send the follow-up, slow down here.',
      '',
      'The win is not more automation.',
      'The win is fewer dropped promises.',
      '',
      'What relationship or commitment would you want your assistant to catch before it slips?'
    ].join('\n');
  }
  if(/meeting|prep|calendar|today|next|transcript|notes/i.test(q)){
    return withDemoCta('VAL has saved meeting notes and transcripts in this demo.\n\nFor Marcus, it remembers procurement and onboarding are the friction points. For Elena, it remembers she needs a clearer first-30-days scope. For Priya, it remembers the renewal risk is team fatigue, not lack of belief.\n\nThe useful part is what happens next: VAL can prep the meeting, draft the recap, create the tasks, and keep the relationship context attached so the user does not have to reconstruct it later.');
  }
  if(/relationship|radar|who matters|priority|contact|connection/i.test(q)){
    return withDemoCta('The highest-priority relationships right now are Marcus, Elena, Jordan, and Priya.\n\nMarcus needs a specific revenue move. Elena needs a credibility move. Jordan needs a quick momentum move. Priya needs a trust-protection move.\n\nThere is also a capacity drift signal here. VAL is holding back on Renee even though she matters, because chasing every relationship at once is how executives drift. The better move is to close the urgent loops first, then nurture the cooling one.');
  }
  if(/capacity|drift|overwhelm|too much|stretched/i.test(q)){
    return withDemoCta('I am noticing capacity drift in the demo account.\n\nThere are more open promises than closed loops: Marcus, Elena, Jordan, Priya, the board update, and a cooling relationship with Renee. None of those are bad. The risk is treating all of them as equally urgent.\n\nVAL would narrow the day to three closures: Marcus, Elena, Jordan. Then it would draft Priya with care and protect a reset block before the user starts anything new.');
  }
  if(/task|todo|to do|priority/i.test(q)){
    return withDemoCta('Task priority is clear.\n\nDo Marcus first because it affects today’s demo. Do Elena second because it protects an influence path. Do Jordan third because warm intros expire quietly. Priya needs care, but not pressure.\n\nVAL can create or update each task, draft the communication, and keep the task tied to the right relationship so the user is not staring at one giant undifferentiated list.');
  }
  if(/draft|email|follow|send|write/i.test(q)){
    return withDemoCta('VAL would not make the user start from a blank page.\n\nIt would draft the Marcus pilot memo, Elena scope reply, Jordan intro ask, and Priya renewal check-in. The user reviews them in the Approval Queue and decides what goes out.\n\nThat is the point: VAL turns relationship memory into almost-done communication.');
  }
  if(/what can|about val|demo|how does/i.test(q)){
    return withDemoCta('This demo is showing the core VAL promise: fewer dropped relationships, fewer forgotten promises, and less executive mental load.\n\nIt remembers transcripts, meeting notes, emails, tasks, drafts, pipeline movement, and relationship context. Then it turns that into the next usable action: draft this, prep that meeting, create this task, slow down here, follow up there.\n\nIt is not trying to make the user busier. It is trying to make the right work easier to finish.');
  }
  if(/reset/i.test(q)){
    return withDemoCta('You can reset this demo any time with the demo reset control. That clears changes made during this visit and restores the sample meetings, transcripts, notes, tasks, drafts, relationships, emails, and pipeline.');
  }
  return withDemoCta('Here is what I see in this demo VAL: Marcus needs the pilot memo before the 2 PM demo, Elena needs a cleaner first-30-days scope, Jordan offered a warm intro that should be used today, and Priya needs a care-first renewal check-in.\n\nSmall warning: the account is showing capacity drift. The user has enough valuable motion already. VAL would close the open loops before starting anything new.');
}

if(process.env.DATABASE_URL){
  try{
    const {Pool} = require('pg');
    pgPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.PGSSLMODE === 'disable' ? false : {rejectUnauthorized:false}
    });
  }catch(e){
    console.error('Postgres disabled:', e.message);
  }
}

async function gh(){
  return ghlMcp.headers();
}
function envNameForSlug(slug,suffix){
  return `GHL_ACCOUNT_${String(slug||'').toUpperCase().replace(/[^A-Z0-9]+/g,'_')}_${suffix}`;
}
function legacyEnvNameForSlug(slug,suffix){
  return `${String(slug||'').toUpperCase().replace(/[^A-Z0-9]+/g,'_')}_GHL_${suffix}`;
}
function normalizeGhlAccount(raw={},idx=0){
  const slug=String(raw.slug||raw.id||raw.name||`ghl-${idx+1}`).trim().toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'')||`ghl-${idx+1}`;
  const calendarIds=Array.isArray(raw.calendarIds)?raw.calendarIds:String(raw.calendarIds||raw.calendarId||'').split(',');
  return {slug,label:raw.label||raw.name||slug,apiKey:raw.apiKey||raw.key||raw.accessToken||'',locationId:raw.locationId||raw.location_id||raw.loc||'',calendarIds:calendarIds.map(v=>String(v||'').trim()).filter(Boolean)};
}
function configuredGhlAccounts(){
  const accounts=[];
  const rawJson=String(process.env.GHL_ACCOUNTS_JSON||'').trim();
  if(rawJson){
    try{
      const parsed=JSON.parse(rawJson);
      const list=Array.isArray(parsed)?parsed:(Array.isArray(parsed.accounts)?parsed.accounts:[]);
      list.map(normalizeGhlAccount).filter(a=>a.apiKey&&a.locationId).forEach(a=>accounts.push(a));
    }catch(e){console.error('GHL_ACCOUNTS_JSON parse error:',e.message);}
  }
  for(const slug of GHL_ACCOUNT_SLUGS){
    const apiKey=process.env[envNameForSlug(slug,'KEY')] || process.env[envNameForSlug(slug,'API_KEY')] || process.env[legacyEnvNameForSlug(slug,'KEY')] || process.env[legacyEnvNameForSlug(slug,'API_KEY')] || '';
    const locationId=process.env[envNameForSlug(slug,'LOC')] || process.env[envNameForSlug(slug,'LOCATION_ID')] || process.env[legacyEnvNameForSlug(slug,'LOC')] || process.env[legacyEnvNameForSlug(slug,'LOCATION_ID')] || '';
    const label=process.env[envNameForSlug(slug,'LABEL')] || process.env[legacyEnvNameForSlug(slug,'LABEL')] || slug;
    const calendarIds=String(process.env[envNameForSlug(slug,'CALENDAR_IDS')] || process.env[envNameForSlug(slug,'CALENDAR_ID')] || process.env[legacyEnvNameForSlug(slug,'CALENDAR_IDS')] || process.env[legacyEnvNameForSlug(slug,'CALENDAR_ID')] || '').split(',').map(v=>v.trim()).filter(Boolean);
    if(apiKey&&locationId) accounts.push({slug:String(slug).toLowerCase(),label,apiKey,locationId,calendarIds});
  }
  if(!accounts.length&&(GHL_KEY||GHL_LOC)) accounts.push({slug:'default',label:process.env.GHL_ACCOUNT_LABEL||'GHL',apiKey:GHL_KEY||'',locationId:GHL_LOC||'',calendarIds:GHL_CALENDAR_IDS});
  const seen=new Set();
  return accounts.filter(a=>{const key=`${a.slug}:${a.locationId}`;if(seen.has(key))return false;seen.add(key);return a.apiKey&&a.locationId;});
}
async function resolvedGhlAccounts(){
  const accounts=configuredGhlAccounts();
  if(accounts.length)return accounts;
  const apiKey=await resolveIntegrationSecret('ghl','api_key',GHL_KEY);
  const locationId=await resolveGhlLocationId();
  return apiKey&&locationId?[{slug:'default',label:process.env.GHL_ACCOUNT_LABEL||'GHL',apiKey,locationId,calendarIds:GHL_CALENDAR_IDS}]:[];
}
function ghlHeadersForAccount(account){
  return ghlMcp.headersForCredentials(ghlMcp.credentialsFromAccount(account));
}
async function prepareGhlRequest(path,body){
  return ghlMcp.prepare(path,body);
}
function prepareGhlRequestForAccount(path,body,account){
  return ghlMcp.prepareForAccount(path,body,account);
}
async function ghl(method,path,body){
  return ghlMcp.request(method,path,body);
}
async function ghlForAccount(account,method,path,body){
  return ghlMcp.requestForAccount(account,method,path,body);
}
async function ghlStrict(method,path,body){
  return ghlMcp.requestStrict(method,path,body);
}
async function readJsonResponse(response){
  const text = await response.text();
  try{ return text ? JSON.parse(text) : {}; }
  catch(e){ return {raw:text}; }
}

async function fetchWithTimeout(url,options={},timeoutMs=10000,label='upstream request'){
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{
    return await fetch(url,{...options,signal:controller.signal});
  }catch(e){
    if(e && e.name==='AbortError'){
      throw new Error(`${label} timed out after ${Math.round(timeoutMs/1000)} seconds`);
    }
    throw e;
  }finally{
    clearTimeout(timer);
  }
}

async function withTimeout(promise,timeoutMs,message){
  let timer;
  const timeout=new Promise((_,reject)=>{
    timer=setTimeout(()=>reject(new Error(message)),timeoutMs);
  });
  try{
    return await Promise.race([promise,timeout]);
  }finally{
    clearTimeout(timer);
  }
}

async function ghlTry(method,path,body){
  return ghlMcp.requestTry(method,path,body);
}
async function ghlTryForAccount(account,method,path,body){
  return ghlMcp.requestTryForAccount(account,method,path,body);
}

function readJson(file,fallback){
  try{ return JSON.parse(fs.readFileSync(file,'utf8')); }
  catch(e){ return fallback; }
}
function writeJson(file,value){
  try{ fs.writeFileSync(file, JSON.stringify(value,null,2)); }
  catch(e){ console.error('writeJson error:',e.message); }
}
function valStore(){
  const store=readJson(STORE_FILE,{conversations:[],messages:[],transcripts:[],memoryItems:[],oauthTokens:{},users:[],sessions:[]});
  ['drafts','templates','transcriptIndex','transcriptParticipants','transcriptSummaries','transcriptTasks','transcriptContactUpdates','transcriptActionLog'].forEach(key=>{if(!Array.isArray(store[key]))store[key]=[];});
  return store;
}
function saveValStore(store){ writeJson(STORE_FILE,store); }
function uuid(prefix){
  return prefix+'_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,8);
}
function parseCookies(req){
  return String(req.headers.cookie||'').split(';').reduce((acc,part)=>{
    const i=part.indexOf('=');
    if(i>0) acc[decodeURIComponent(part.slice(0,i).trim())]=decodeURIComponent(part.slice(i+1).trim());
    return acc;
  },{});
}
function signValue(value){
  return crypto.createHmac('sha256',SESSION_SECRET).update(value).digest('hex');
}
function signedSessionValue(sessionId){
  return `${sessionId}.${signValue(sessionId)}`;
}
function verifySignedSession(value){
  const [sessionId,sig]=String(value||'').split('.');
  if(!sessionId||!sig) return '';
  const expected=signValue(sessionId);
  try{
    return crypto.timingSafeEqual(Buffer.from(sig),Buffer.from(expected)) ? sessionId : '';
  }catch(e){return '';}
}
function setSessionCookie(res,sessionId){
  const secure=process.env.NODE_ENV==='production' || !!process.env.RAILWAY_PUBLIC_DOMAIN;
  const sameSite=process.env.VAL_COOKIE_SAMESITE || (secure?'None':'Lax');
  res.setHeader('Set-Cookie',`${SESSION_COOKIE}=${encodeURIComponent(signedSessionValue(sessionId))}; Path=/; HttpOnly; SameSite=${sameSite}; Max-Age=${60*60*24*14}${secure?'; Secure':''}`);
}
function clearSessionCookie(res){
  const secure=process.env.NODE_ENV==='production' || !!process.env.RAILWAY_PUBLIC_DOMAIN;
  const sameSite=process.env.VAL_COOKIE_SAMESITE || (secure?'None':'Lax');
  res.setHeader('Set-Cookie',`${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=${sameSite}; Max-Age=0${secure?'; Secure':''}`);
}
async function hashPassword(password){
  return `bcrypt:${await bcrypt.hash(String(password||''),12)}`;
}
function hashLegacyPassword(password,salt=crypto.randomBytes(16).toString('hex')){
  const hash=crypto.scryptSync(String(password||''),salt,64).toString('hex');
  return `scrypt:${salt}:${hash}`;
}
async function verifyPassword(password,stored){
  if(String(stored||'').startsWith('bcrypt:')) return bcrypt.compare(String(password||''),String(stored).slice(7));
  const [kind,salt,hash]=String(stored||'').split(':');
  if(kind!=='scrypt'||!salt||!hash) return false;
  const candidate=hashLegacyPassword(password,salt).split(':')[2];
  try{return crypto.timingSafeEqual(Buffer.from(candidate,'hex'),Buffer.from(hash,'hex'));}
  catch(e){return false;}
}
function passwordSetupToken(){
  return crypto.randomBytes(32).toString('base64url');
}
function hashPasswordSetupToken(token){
  return crypto.createHash('sha256').update(String(token||'')).digest('hex');
}
function passwordSetupUrl(token){
  const base=CLIENT_CONFIG.publicBaseUrl ? CLIENT_CONFIG.publicBaseUrl.replace(/\/$/,'') : '';
  return `${base}/set-password?token=${encodeURIComponent(token)}`;
}
function passwordSetupUrlForRequest(req,token){
  const base=requestBaseUrl(req);
  return `${base}/set-password?token=${encodeURIComponent(token)}`;
}
function authLog(event,details={}){
  const safe={...details};
  if(safe.email) safe.email=String(safe.email).trim().toLowerCase();
  if(safe.token) delete safe.token;
  console.log(`[auth] ${event}`,safe);
}
function publicUser(user){
  if(!user) return null;
  return {id:user.id,email:user.email,name:user.name,role:user.role||'owner'};
}
async function seedAdminUser(){
  const email=String(process.env.ADMIN_EMAIL||'').trim().toLowerCase();
  const password=String(process.env.ADMIN_PASSWORD||'');
  const forcePasswordSync=/^(1|true|yes)$/i.test(String(process.env.ADMIN_FORCE_PASSWORD_SYNC || process.env.VAL_FORCE_ADMIN_PASSWORD_RESET || ''));
  if(!email) return;
  const name=process.env.ADMIN_NAME || CLIENT_CONFIG.clientName || 'VAL Admin';
  const role=process.env.ADMIN_ROLE || 'owner';
  const passwordHash=password ? await hashPassword(password) : null;
  const passwordSetAt=password ? new Date().toISOString() : null;
  if(pgPool){
    const exists=await dbQuery('select id,password_hash from val_users where lower(email)=lower($1) limit 1',[email]);
    if(exists&&exists.rows&&exists.rows.length){
      const existing=exists.rows[0];
      if(password&&(!existing.password_hash||forcePasswordSync)){
        await dbQuery('update val_users set password_hash=$1,password_set_at=now(),updated_at=now() where id=$2',[passwordHash,existing.id]);
        authLog(forcePasswordSync?'Synced admin password from env':'Filled missing admin password from env',{email,userId:existing.id,clientSlug:CLIENT_CONFIG.clientSlug});
      }
      return;
    }
    await dbQuery('insert into val_users (id,client_slug,tenant_id,name,email,password_hash,password_set_at,role) values ($1,$2,$3,$4,$5,$6,$7,$8)',[uuid('usr'),CLIENT_CONFIG.clientSlug,CLIENT_CONFIG.clientSlug,name,email,passwordHash,passwordSetAt,role]);
    authLog(password?'Seeded VAL admin user':'Seeded VAL admin user pending password setup',{email,clientSlug:CLIENT_CONFIG.clientSlug});
    return;
  }
  const store=valStore();
  store.users=store.users||[];
  const existingUser=store.users.find(u=>String(u.email||'').toLowerCase()===email);
  if(existingUser){
    if(password&&(!existingUser.passwordHash||forcePasswordSync)){
      existingUser.passwordHash=passwordHash;
      existingUser.passwordSetAt=new Date().toISOString();
      existingUser.updatedAt=new Date().toISOString();
      saveValStore(store);
      authLog(forcePasswordSync?'Synced admin password from env':'Filled missing admin password from env',{email,userId:existingUser.id,clientSlug:CLIENT_CONFIG.clientSlug});
    }
    return;
  }
  store.users.push({id:uuid('usr'),clientSlug:CLIENT_CONFIG.clientSlug,tenantId:CLIENT_CONFIG.clientSlug,name,email,passwordHash,passwordSetAt,role,createdAt:new Date().toISOString()});
  saveValStore(store);
  authLog(password?'Seeded VAL admin user':'Seeded VAL admin user pending password setup',{email,clientSlug:CLIENT_CONFIG.clientSlug});
}
async function findUserByEmail(email){
  const normalized=String(email||'').trim().toLowerCase();
  if(!normalized) return null;
  if(pgPool){
    const r=await dbQuery('select * from val_users where lower(email)=lower($1) limit 1',[normalized]);
    const row=r&&r.rows&&r.rows[0];
    return row?{id:row.id,email:row.email,name:row.name,role:row.role,passwordHash:row.password_hash,passwordSetAt:row.password_set_at}:null;
  }
  const user=(valStore().users||[]).find(u=>String(u.email||'').toLowerCase()===normalized);
  return user?{id:user.id,email:user.email,name:user.name,role:user.role,passwordHash:user.passwordHash,passwordSetAt:user.passwordSetAt}:null;
}
async function storePasswordSetupToken(userId,tokenHash,expiresAt){
  if(pgPool){
    await dbQuery('update val_users set password_reset_token_hash=$1,password_reset_expires_at=$2,updated_at=now() where id=$3',[tokenHash,expiresAt,userId]);
    return;
  }
  const store=valStore();
  const user=(store.users||[]).find(u=>u.id===userId);
  if(user){
    user.passwordResetTokenHash=tokenHash;
    user.passwordResetExpiresAt=expiresAt;
    user.updatedAt=new Date().toISOString();
    saveValStore(store);
  }
}
async function findUserByPasswordSetupToken(token){
  const tokenHash=hashPasswordSetupToken(token);
  if(pgPool){
    const r=await dbQuery('select * from val_users where password_reset_token_hash=$1 and password_reset_expires_at>now() limit 1',[tokenHash]);
    const row=r&&r.rows&&r.rows[0];
    return row?{id:row.id,email:row.email,name:row.name,role:row.role,passwordHash:row.password_hash,passwordSetAt:row.password_set_at}:null;
  }
  const user=(valStore().users||[]).find(u=>u.passwordResetTokenHash===tokenHash&&new Date(u.passwordResetExpiresAt||0).getTime()>Date.now());
  return user?{id:user.id,email:user.email,name:user.name,role:user.role,passwordHash:user.passwordHash,passwordSetAt:user.passwordSetAt}:null;
}
async function setUserPassword(userId,passwordHash){
  if(pgPool){
    await dbQuery('update val_users set password_hash=$1,password_set_at=now(),password_reset_token_hash=null,password_reset_expires_at=null,updated_at=now() where id=$2',[passwordHash,userId]);
    return;
  }
  const store=valStore();
  const user=(store.users||[]).find(u=>u.id===userId);
  if(user){
    user.passwordHash=passwordHash;
    user.passwordSetAt=new Date().toISOString();
    user.passwordResetTokenHash=null;
    user.passwordResetExpiresAt=null;
    user.updatedAt=new Date().toISOString();
    saveValStore(store);
  }
}
function currentValUser(){
  return requestContext.getStore()?.user || null;
}
function currentUserId(){
  return currentValUser()?.id || VAL_USER_ID;
}
function tenantId(){
  return CLIENT_CONFIG.clientSlug || 'default';
}
function transcriptWebhookToken(){
  return process.env.TRANSCRIPT_WEBHOOK_TOKEN || crypto.createHmac('sha256',SESSION_SECRET).update(`transcript:${tenantId()}`).digest('hex').slice(0,48);
}
function isValidTranscriptWebhookReq(req){
  const token=String(req.query.token||req.headers['x-val-transcript-token']||'');
  const expected=transcriptWebhookToken();
  if(!token||!expected)return false;
  try{return crypto.timingSafeEqual(Buffer.from(token),Buffer.from(expected));}
  catch(e){return false;}
}
function requestBaseUrl(req){
  return (CLIENT_CONFIG.publicBaseUrl || `${req.protocol}://${req.get('host')}`).replace(/\/+$/,'');
}
function transcriptWebhookInfo(req){
  const base=requestBaseUrl(req);
  const token=transcriptWebhookToken();
  return {
    ok:true,
    live:true,
    status:'live',
    clientName:CLIENT_CONFIG.clientName,
    clientSlug:CLIENT_CONFIG.clientSlug,
    method:'POST',
    url:`${base}/api/val/transcripts?token=${encodeURIComponent(token)}`,
    pingUrl:`${base}/api/val/transcripts/ping?token=${encodeURIComponent(token)}`,
    authentication:'Signed webhook URL',
    contentType:'application/json',
    processDefault:true,
    recent30DaysCount:0,
    matchedToMeetings30DaysCount:0,
    lastReceivedAt:null,
    lastTranscriptTitle:'',
    message:'Webhook is live. Send POST requests with JSON to this URL from a transcriber, Make.com, Zapier, or any tool that can call a webhook.',
    acceptedTranscriptFields:['transcript','rawText','text'],
    samplePayload:{
      title:'Meeting with Contact Name',
      transcript:'Full transcript text here...',
      source:'transcription_app',
      timestamp:new Date().toISOString(),
      process:true,
      metadata:{eventTitle:'Calendar event title',contactEmail:'contact@example.com'}
    }
  };
}
function encryptionKeyBuffer(){
  const raw=String(process.env.ENCRYPTION_KEY||'').trim();
  if(!raw) return null;
  if(/^[a-f0-9]{64}$/i.test(raw)) return Buffer.from(raw,'hex');
  try{
    const b=Buffer.from(raw,'base64');
    if(b.length===32) return b;
  }catch(e){}
  return crypto.createHash('sha256').update(raw).digest();
}
function encryptSecret(value){
  const key=encryptionKeyBuffer();
  if(!key) throw new Error('ENCRYPTION_KEY is required to save credentials');
  const iv=crypto.randomBytes(12);
  const cipher=crypto.createCipheriv('aes-256-gcm',key,iv);
  const encrypted=Buffer.concat([cipher.update(String(value||''),'utf8'),cipher.final()]);
  return ['v1',iv.toString('base64'),cipher.getAuthTag().toString('base64'),encrypted.toString('base64')].join(':');
}
function decryptSecret(value){
  const key=encryptionKeyBuffer();
  if(!key) throw new Error('ENCRYPTION_KEY is required to read saved credentials');
  const [version,ivRaw,tagRaw,dataRaw]=String(value||'').split(':');
  if(version!=='v1'||!ivRaw||!tagRaw||!dataRaw) return '';
  const decipher=crypto.createDecipheriv('aes-256-gcm',key,Buffer.from(ivRaw,'base64'));
  decipher.setAuthTag(Buffer.from(tagRaw,'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataRaw,'base64')),decipher.final()]).toString('utf8');
}
function maskSecret(value){
  const v=String(value||'');
  if(!v) return '';
  if(v.length<=8) return '••••';
  return `${v.slice(0,Math.min(4,v.length-4))}...${v.slice(-4)}`;
}
function normalizeCredentialRow(row){
  if(!row) return null;
  const meta=row.metadata_json||row.metadataJson||{};
  let masked='';
  try{ masked=maskSecret(decryptSecret(row.encrypted_value||row.encryptedValue)); }
  catch(e){ masked=row.encrypted_value||row.encryptedValue?'saved':''; }
  return {
    id:row.id,
    userId:row.user_id||row.userId||'',
    tenantId:row.tenant_id||row.tenantId||tenantId(),
    provider:row.provider,
    credentialType:row.credential_type||row.credentialType,
    maskedValue:masked,
    metadata:meta,
    status:row.status||'Not tested',
    lastTestedAt:row.last_tested_at||row.lastTestedAt||null,
    createdAt:row.created_at||row.createdAt||null,
    updatedAt:row.updated_at||row.updatedAt||null
  };
}
async function saveIntegrationCredential({userId,provider,credentialType,value,metadata={},status='Not tested'}){
  const id=uuid('cred');
  const encrypted=encryptSecret(value);
  const now=new Date().toISOString();
  if(pgPool){
    const r=await dbQuery(`
      insert into user_integration_credentials
        (id,user_id,tenant_id,provider,credential_type,encrypted_value,metadata_json,status,created_at,updated_at)
      values ($1,$2,$3,$4,$5,$6,$7,$8,now(),now())
      on conflict (tenant_id,user_id,provider,credential_type)
      do update set encrypted_value=excluded.encrypted_value,metadata_json=excluded.metadata_json,status=excluded.status,updated_at=now()
      returning *
    `,[id,userId,tenantId(),provider,credentialType,encrypted,metadata,status]);
    return normalizeCredentialRow(r.rows[0]);
  }
  const store=valStore();
  store.integrationCredentials=store.integrationCredentials||[];
  let row=store.integrationCredentials.find(c=>c.tenantId===tenantId()&&c.userId===userId&&c.provider===provider&&c.credentialType===credentialType);
  if(!row){
    row={id,userId,tenantId:tenantId(),provider,credentialType,createdAt:now};
    store.integrationCredentials.push(row);
  }
  row.encryptedValue=encrypted;
  row.metadataJson=metadata;
  row.status=status;
  row.updatedAt=now;
  saveValStore(store);
  return normalizeCredentialRow(row);
}
async function listIntegrationCredentials(userId){
  if(pgPool){
    const r=await dbQuery(`
      select * from user_integration_credentials
      where tenant_id=$1 and (user_id=$2 or user_id is null)
      order by provider, credential_type
    `,[tenantId(),userId]);
    return (r.rows||[]).map(normalizeCredentialRow);
  }
  return (valStore().integrationCredentials||[])
    .filter(c=>c.tenantId===tenantId()&&(c.userId===userId||!c.userId))
    .map(normalizeCredentialRow);
}
async function deleteIntegrationCredential(id,userId){
  if(pgPool){
    await dbQuery('delete from user_integration_credentials where id=$1 and tenant_id=$2 and (user_id=$3 or user_id is null)',[id,tenantId(),userId]);
    return;
  }
  const store=valStore();
  store.integrationCredentials=(store.integrationCredentials||[]).filter(c=>!(c.id===id&&c.tenantId===tenantId()&&(c.userId===userId||!c.userId)));
  saveValStore(store);
}
async function getIntegrationCredential(provider,credentialType,userId=currentValUser()?.id){
  if(!userId) return null;
  if(pgPool){
    const r=await dbQuery(`
      select * from user_integration_credentials
      where tenant_id=$1 and provider=$2 and credential_type=$3 and (user_id=$4 or user_id is null)
      order by case when user_id=$4 then 0 else 1 end, updated_at desc
      limit 1
    `,[tenantId(),provider,credentialType,userId]);
    return r.rows?.[0]||null;
  }
  return (valStore().integrationCredentials||[])
    .filter(c=>c.tenantId===tenantId()&&c.provider===provider&&c.credentialType===credentialType&&(c.userId===userId||!c.userId))
    .sort((a,b)=>(a.userId===userId?-1:1))
    [0] || null;
}
async function resolveIntegrationSecret(provider,credentialType,fallback=''){
  const row=await getIntegrationCredential(provider,credentialType);
  if(row?.encrypted_value||row?.encryptedValue){
    try{return decryptSecret(row.encrypted_value||row.encryptedValue);}
    catch(e){
      console.error(`Credential read failed for ${provider}/${credentialType}:`,e.message);
    }
  }
  return fallback || '';
}
async function resolveOpenAIKey(){ return resolveIntegrationSecret('openai','api_key',OPENAI_KEY); }
async function resolveAnthropicKey(){ return resolveIntegrationSecret('anthropic','api_key',ANTHROPIC_KEY); }
async function resolveOpenAIModel(){
  return resolveIntegrationSecret('openai','preferred_model',OPENAI_CHAT_MODEL);
}
async function resolveGhlLocationId(){
  return resolveIntegrationSecret('ghl','location_id',GHL_LOC);
}
async function markCredentialStatus(provider,status){
  const user=currentValUser();
  if(!user) return;
  if(pgPool){
    await dbQuery('update user_integration_credentials set status=$1,last_tested_at=now(),updated_at=now() where tenant_id=$2 and user_id=$3 and provider=$4',[status,tenantId(),user.id,provider]);
    return;
  }
  const store=valStore();
  (store.integrationCredentials||[]).forEach(c=>{
    if(c.tenantId===tenantId()&&c.userId===user.id&&c.provider===provider){
      c.status=status;c.lastTestedAt=new Date().toISOString();c.updatedAt=new Date().toISOString();
    }
  });
  saveValStore(store);
}
async function createSession(userId){
  const id=uuid('sess');
  const expires=new Date(Date.now()+14*24*60*60*1000).toISOString();
  if(pgPool){
    await dbQuery('insert into val_sessions (id,user_id,client_slug,expires_at) values ($1,$2,$3,$4)',[id,userId,CLIENT_CONFIG.clientSlug,expires]);
  }else{
    const store=valStore();
    store.sessions=store.sessions||[];
    store.sessions.push({id,userId,clientSlug:CLIENT_CONFIG.clientSlug,expiresAt:expires});
    saveValStore(store);
  }
  return id;
}
async function getSessionUser(req){
  const signed=parseCookies(req)[SESSION_COOKIE];
  const sessionId=verifySignedSession(signed);
  if(!sessionId) return null;
  if(pgPool){
    const r=await dbQuery(`select u.id,u.email,u.name,u.role from val_sessions s join val_users u on u.id=s.user_id where s.id=$1 and s.expires_at>now() limit 1`,[sessionId]);
    return r&&r.rows&&r.rows[0]?publicUser(r.rows[0]):null;
  }
  const store=valStore();
  const session=(store.sessions||[]).find(s=>s.id===sessionId&&new Date(s.expiresAt).getTime()>Date.now());
  if(!session) return null;
  return publicUser((store.users||[]).find(u=>u.id===session.userId));
}
async function destroySession(req){
  const sessionId=verifySignedSession(parseCookies(req)[SESSION_COOKIE]);
  if(!sessionId) return;
  if(pgPool) await dbQuery('delete from val_sessions where id=$1',[sessionId]);
  else{
    const store=valStore();
    store.sessions=(store.sessions||[]).filter(s=>s.id!==sessionId);
    saveValStore(store);
  }
}
function memoryChunks(text){
  const clean = String(text||'').replace(/\r\n/g,'\n').trim();
  if(!clean) return [];
  if(clean.length <= MEMORY_CHUNK_SIZE) return [clean];
  const chunks = [];
  let start = 0;
  while(start < clean.length){
    let end = Math.min(start + MEMORY_CHUNK_SIZE, clean.length);
    if(end < clean.length){
      const breakAt = Math.max(clean.lastIndexOf('\n\n',end), clean.lastIndexOf('. ',end), clean.lastIndexOf('\n',end));
      if(breakAt > start + MEMORY_CHUNK_SIZE * 0.55) end = breakAt + 1;
    }
    chunks.push(clean.slice(start,end).trim());
    if(end >= clean.length) break;
    start = Math.max(0,end - MEMORY_CHUNK_OVERLAP);
  }
  return chunks.filter(Boolean);
}
function queryTerms(text){
  const stop = new Set(['about','after','again','all','also','and','are','because','been','but','can','could','does','for','from','have','her','him','how','into','just','like','more','need','not','now','our','out','she','should','that','the','their','then','there','they','this','through','what','when','where','which','with','would','you','your']);
  return String(text||'').toLowerCase().match(/[a-z0-9']{3,}/g)?.filter(w=>!stop.has(w)).slice(-20) || [];
}
function isDocumentMemoryQuery(text){
  return /\b(document|documents|file|files|upload|uploaded|transcript|transcripts|summary|summarize|overview|saved|vault|about them|what are they|mgsh)\b/i.test(String(text||''));
}
function scoreMemory(item,terms){
  const hay = `${item.kind||''} ${item.summary||''} ${item.raw_text||item.rawText||''} ${JSON.stringify(item.metadata||{})}`.toLowerCase();
  return terms.reduce((score,term)=>score+(hay.includes(term)?1:0),0) + ((item.importance||1) * 0.1);
}
async function dbQuery(sql,params){
  if(!pgPool) return null;
  try{
    return await pgPool.query(sql,params);
  }catch(e){
    console.error('Postgres unavailable, falling back to file store:',e.message);
    try{ await pgPool.end(); }catch(_){}
    pgPool = null;
    return {rows:[],rowCount:0};
  }
}
async function initValDb(){
  if(!pgPool) return;
  await dbQuery(`
    create table if not exists val_tasks (
      id text primary key,
      user_id text not null default 'default',
      title text not null,
      contact_name text,
      due_date timestamptz,
      notes text,
      details jsonb not null default '[]',
      completed boolean not null default false,
      completed_at timestamptz,
      completed_by text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    create table if not exists val_conversations (
      id text primary key,
      user_id text not null default 'default',
      title text,
      source text not null default 'chat',
      metadata jsonb not null default '{}',
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    create table if not exists val_messages (
      id text primary key,
      conversation_id text references val_conversations(id) on delete cascade,
      role text not null,
      content text not null,
      metadata jsonb not null default '{}',
      created_at timestamptz not null default now()
    );
    create table if not exists val_transcripts (
      id text primary key,
      user_id text not null default 'default',
      type text not null,
      title text,
      raw_text text not null,
      metadata jsonb not null default '{}',
      created_at timestamptz not null default now()
    );
    create table if not exists transcripts (
      transcript_id text primary key,
      user_id text not null default 'default',
      tenant_id text not null default 'default',
      source text not null default 'unknown',
      meeting_title text,
      meeting_datetime timestamptz,
      calendar_event_id text,
      raw_transcript text not null,
      processing_status text not null default 'received',
      summary_status text not null default 'pending',
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    create table if not exists transcript_participants (
      participant_id text primary key,
      transcript_id text not null references transcripts(transcript_id) on delete cascade,
      speaker_name_raw text,
      matched_contact_id text,
      matched_contact_name text,
      matched_email text,
      matched_phone text,
      matched_company text,
      match_confidence numeric not null default 0,
      match_reason text,
      needs_review boolean not null default true,
      created_at timestamptz not null default now()
    );
    create table if not exists transcript_summaries (
      summary_id text primary key,
      transcript_id text not null references transcripts(transcript_id) on delete cascade,
      executive_summary text not null,
      client_summary text,
      internal_notes text,
      key_decisions jsonb not null default '[]',
      open_questions jsonb not null default '[]',
      relationship_updates jsonb not null default '[]',
      created_at timestamptz not null default now()
    );
    create table if not exists transcript_tasks (
      task_id text primary key,
      transcript_id text not null references transcripts(transcript_id) on delete cascade,
      assigned_to_contact_id text,
      assigned_to_name text,
      task_title text not null,
      task_description text,
      due_date timestamptz,
      priority text not null default 'medium',
      confidence numeric not null default 0,
      status text not null default 'staged',
      needs_approval boolean not null default true,
      source_quote text not null,
      created_at timestamptz not null default now()
    );
    create table if not exists transcript_contact_updates (
      update_id text primary key,
      transcript_id text not null references transcripts(transcript_id) on delete cascade,
      contact_id text,
      field_to_update text not null,
      old_value text,
      new_value text,
      reason text,
      source_quote text not null,
      confidence numeric not null default 0,
      approved boolean not null default false,
      created_at timestamptz not null default now()
    );
    create table if not exists transcript_action_log (
      action_id text primary key,
      transcript_id text not null references transcripts(transcript_id) on delete cascade,
      action_type text not null,
      target_record_id text,
      status text not null,
      error_message text,
      created_at timestamptz not null default now()
    );
    create table if not exists val_memory_items (
      id text primary key,
      user_id text not null default 'default',
      kind text not null default 'note',
      summary text,
      raw_text text not null,
      importance integer not null default 1,
      metadata jsonb not null default '{}',
      created_at timestamptz not null default now()
    );
    create table if not exists val_oauth_tokens (
      provider text primary key,
      user_id text not null default 'default',
      tokens jsonb not null,
      updated_at timestamptz not null default now()
    );
    create table if not exists drafts (
      id text primary key,
      user_id text not null default 'default',
      tenant_id text not null default 'default',
      draft_type text not null default 'follow_up',
      contact_id text,
      provider text not null default 'internal',
      subject text,
      body text not null default '',
      status text not null default 'draft',
      source_context_json jsonb not null default '{}',
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    create table if not exists val_templates (
      id text primary key,
      user_id text not null default 'default',
      tenant_id text not null default 'default',
      template_key text not null,
      name text not null,
      subject_template text not null default '',
      html_template text not null default '',
      text_template text not null default '',
      is_active boolean not null default true,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (tenant_id,user_id,template_key)
    );
    create table if not exists meeting_transcript_links (
      id text primary key,
      user_id text not null default 'default',
      tenant_id text not null default 'default',
      meeting_source text,
      meeting_event_id text,
      transcript_id text,
      confidence numeric,
      matched_reason text,
      created_at timestamptz not null default now(),
      unique (user_id,tenant_id,meeting_source,meeting_event_id,transcript_id)
    );
    create table if not exists val_calendar_events (
      id text primary key,
      user_id text not null default 'default',
      tenant_id text not null default 'default',
      source text not null default 'val',
      title text not null,
      start_time timestamptz,
      end_time timestamptz,
      attendees jsonb not null default '[]',
      metadata jsonb not null default '{}',
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    create table if not exists val_users (
      id text primary key,
      client_slug text not null default 'default',
      tenant_id text not null default 'default',
      name text,
      email text not null unique,
      password_hash text,
      password_set_at timestamptz,
      password_reset_token_hash text,
      password_reset_expires_at timestamptz,
      role text not null default 'owner',
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    create table if not exists val_sessions (
      id text primary key,
      user_id text references val_users(id) on delete cascade,
      client_slug text not null default 'default',
      expires_at timestamptz not null,
      created_at timestamptz not null default now()
    );
    create table if not exists user_integration_credentials (
      id text primary key,
      user_id text references val_users(id) on delete cascade,
      tenant_id text not null default 'default',
      provider text not null,
      credential_type text not null,
      encrypted_value text not null,
      metadata_json jsonb not null default '{}',
      status text not null default 'Not tested',
      last_tested_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (tenant_id,user_id,provider,credential_type)
    );
    create table if not exists email_rules (
      id text primary key,
      user_id text,
      tenant_id text not null default 'default',
      provider text not null default 'any',
      rule_name text not null,
      rule_type text not null,
      conditions_json jsonb not null default '{}',
      actions_json jsonb not null default '{}',
      approval_mode text not null default 'review_only',
      confidence_threshold text not null default 'medium',
      is_active boolean not null default true,
      created_from text,
      created_from_message_id text,
      created_from_thread_id text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      last_used_at timestamptz,
      usage_count integer not null default 0
    );
    create table if not exists email_action_log (
      id text primary key,
      user_id text,
      tenant_id text not null default 'default',
      provider text not null,
      message_id text,
      thread_id text,
      action_type text not null,
      action_status text not null default 'suggested',
      acted_by text not null default 'val',
      rule_id text,
      details_json jsonb not null default '{}',
      created_at timestamptz not null default now()
    );
    create index if not exists val_tasks_user_completed_idx on val_tasks(user_id,completed,due_date);
    create index if not exists val_messages_conversation_idx on val_messages(conversation_id,created_at);
    create index if not exists val_transcripts_user_created_idx on val_transcripts(user_id,created_at desc);
    create index if not exists transcripts_user_created_idx on transcripts(user_id,created_at desc);
    create index if not exists transcript_participants_transcript_idx on transcript_participants(transcript_id,needs_review);
    create index if not exists transcript_tasks_transcript_idx on transcript_tasks(transcript_id,needs_approval,status);
    create index if not exists transcript_updates_transcript_idx on transcript_contact_updates(transcript_id,approved);
    create index if not exists transcript_action_log_transcript_idx on transcript_action_log(transcript_id,created_at);
    create index if not exists val_memory_user_created_idx on val_memory_items(user_id,created_at desc);
    create index if not exists val_sessions_user_expires_idx on val_sessions(user_id,expires_at);
    create index if not exists user_integration_credentials_lookup_idx on user_integration_credentials(tenant_id,user_id,provider,credential_type);
    create index if not exists email_rules_lookup_idx on email_rules(tenant_id,user_id,is_active,rule_type);
    create index if not exists email_action_log_lookup_idx on email_action_log(tenant_id,user_id,action_type,created_at desc);
    create index if not exists drafts_lookup_idx on drafts(tenant_id,user_id,status,created_at desc);
    create index if not exists val_templates_lookup_idx on val_templates(tenant_id,user_id,template_key,is_active);
    create index if not exists meeting_transcript_links_lookup_idx on meeting_transcript_links(tenant_id,user_id,meeting_event_id,created_at desc);
    create index if not exists val_calendar_events_lookup_idx on val_calendar_events(tenant_id,user_id,start_time desc);
  `);
  for(const table of ['val_tasks','val_conversations','val_transcripts','val_memory_items','val_oauth_tokens']){
    await dbQuery(`alter table ${table} add column if not exists client_slug text not null default 'default'`);
    await dbQuery(`alter table ${table} add column if not exists tenant_id text not null default 'default'`);
  }
  await dbQuery(`alter table val_oauth_tokens drop constraint if exists val_oauth_tokens_pkey`);
  await dbQuery(`create unique index if not exists val_oauth_tokens_scope_idx on val_oauth_tokens(tenant_id,user_id,provider)`);
  await dbQuery('alter table val_users alter column password_hash drop not null');
  await dbQuery('alter table val_users add column if not exists password_set_at timestamptz');
  await dbQuery('alter table val_users add column if not exists password_reset_token_hash text');
  await dbQuery('alter table val_users add column if not exists password_reset_expires_at timestamptz');
  await dbQuery('alter table meeting_transcript_links add column if not exists contact_id text');
  await dbQuery('alter table meeting_transcript_links add column if not exists updated_at timestamptz not null default now()');
  await dbQuery('alter table val_tasks add column if not exists completed_at timestamptz');
  await dbQuery('alter table val_tasks add column if not exists completed_by text');
  await seedAdminUser();
  console.log('VAL Postgres store ready');
}
const valDbReady = initValDb().then(()=>seedAdminUser()).catch(e=>console.error('VAL DB init error:',e.message));

function loginHtml(){
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${CLIENT_CONFIG.brandName} Login</title><style>
  :root{color-scheme:dark;--navy:#14243a;--ink:#07111d;--cream:#f4efe5;--gold:#c9a45d}
  *{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:linear-gradient(180deg,var(--navy),var(--ink));color:var(--cream);font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;padding:24px}
  .card{width:min(420px,100%);border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.055);border-radius:14px;padding:30px;box-shadow:0 24px 80px rgba(0,0,0,.28)}
  .brand{font-family:Georgia,serif;font-size:34px;letter-spacing:.08em;margin:0 0 6px}.sub{color:rgba(244,239,229,.68);line-height:1.5;margin:0 0 24px}
  label{display:block;font-size:12px;text-transform:uppercase;letter-spacing:.16em;color:var(--gold);margin:16px 0 8px}
  input{width:100%;border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.08);color:var(--cream);border-radius:10px;padding:13px 14px;font-size:15px;outline:none}
  button{width:100%;margin-top:22px;border:1px solid rgba(201,164,93,.55);background:rgba(201,164,93,.18);color:var(--cream);border-radius:10px;padding:13px 14px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;cursor:pointer}
  .linkbtn{border-color:rgba(255,255,255,.16);background:rgba(255,255,255,.06);margin-top:12px;color:rgba(244,239,229,.84)}
  .err{min-height:22px;color:#ffb4a8;margin-top:14px;font-size:14px;line-height:1.45}.msg{color:rgba(244,239,229,.78);font-size:14px;line-height:1.5;margin-top:14px}.setup{display:none;margin-top:20px;padding-top:18px;border-top:1px solid rgba(255,255,255,.12)}.setup a{color:var(--gold);word-break:break-all}
  </style></head><body><main class="card"><form id="loginForm"><h1 class="brand">${CLIENT_CONFIG.brandName}</h1><p class="sub">Sign in to your private VAL dashboard.</p><label>Email</label><input id="email" type="email" autocomplete="email" required><label>Password</label><input id="password" type="password" autocomplete="current-password" required><button type="submit">Enter VAL</button><button class="linkbtn" type="button" id="showSetup">First time here? Set your password.</button><div class="err" id="err"></div></form><section class="setup" id="setupBox"><p class="msg">Enter your email and VAL will create a secure setup link. For testing, the link appears here.</p><label>Account Email</label><input id="setupEmail" type="email" autocomplete="email"><button type="button" id="requestSetup">Create Setup Link</button><div class="msg" id="setupMsg"></div></section></main><script>
  const emailInput=document.getElementById('email');
  const passwordInput=document.getElementById('password');
  const setupEmailInput=document.getElementById('setupEmail');
  const setupButton=document.getElementById('requestSetup');
  const loginError=document.getElementById('err');
  const setupBox=document.getElementById('setupBox');
  const setupMsg=document.getElementById('setupMsg');
  function showSetupBox(){setupEmailInput.value=emailInput.value||setupEmailInput.value;setupBox.style.display='block';setupMsg.textContent='';}
  async function requestSetupLink(){
    const requestedEmail=(setupEmailInput.value||emailInput.value||'').trim();
    console.log('[auth-ui] request-password-setup click',{hasEmail:!!requestedEmail});
    setupMsg.textContent='';
    if(!requestedEmail){setupMsg.innerHTML='<span style="color:#ffb4a8">Enter your account email first.</span>';setupEmailInput.focus();return;}
    setupButton.disabled=true;
    setupButton.textContent='Creating...';
    setupMsg.textContent='Creating setup link...';
    try{
      const r=await fetch('/api/auth/request-password-setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:requestedEmail})});
      const d=await r.json().catch(()=>({}));
      console.log('[auth-ui] request-password-setup response',{status:r.status,ok:r.ok,hasSetupUrl:!!d.setupUrl,error:d.error||''});
      if(!r.ok||d.ok===false){
        setupMsg.innerHTML='<span style="color:#ffb4a8">'+(d.error||d.message||'Could not create setup link. Check Railway logs for the auth request.')+'</span>';
        return;
      }
      setupMsg.innerHTML=(d.message||'If that email exists, a setup link has been created.')+(d.setupUrl?'<br><br><strong>Testing setup link:</strong><br><a href="'+d.setupUrl+'">'+d.setupUrl+'</a>':'<br><br><span style="color:#ffb4a8">No setup URL was returned. The email may not exist yet, or the admin user was not seeded. Check Railway logs for [auth] entries.</span>');
    }catch(err){
      console.error('[auth-ui] request-password-setup failed',err);
      setupMsg.innerHTML='<span style="color:#ffb4a8">Setup request failed: '+(err.message||err)+'</span>';
    }finally{
      setupButton.disabled=false;
      setupButton.textContent='Create Setup Link';
    }
  }
  document.getElementById('showSetup').addEventListener('click',showSetupBox);
  document.getElementById('requestSetup').addEventListener('click',requestSetupLink);
  document.getElementById('loginForm').addEventListener('submit',async function(e){
    e.preventDefault();loginError.textContent='';
    try{
      const r=await fetch('/api/auth/login',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:emailInput.value,password:passwordInput.value})});
      const d=await r.json().catch(()=>({}));
      console.log('[auth-ui] login response',{status:r.status,ok:r.ok,requiresPasswordSetup:!!d.requiresPasswordSetup});
      if(r.ok&&d.ok){
        loginError.style.color='rgba(244,239,229,.78)';
        loginError.textContent='Password accepted. Opening VAL...';
        const me=await fetch('/api/auth/me',{credentials:'same-origin'}).then(function(x){return x.json().catch(function(){return {ok:false,error:'Session check failed'};});}).catch(function(err){return {ok:false,error:err.message||String(err)};});
        console.log('[auth-ui] session check after login',{ok:!!me.ok,error:me.error||''});
        if(me.ok){
          window.location.assign(d.redirectUrl||'/dashboard');
          setTimeout(function(){window.location.href=d.redirectUrl||'/dashboard';},450);
          return;
        }
        loginError.style.color='#ffb4a8';
        loginError.textContent='Password accepted, but the browser did not keep the login session. Refresh and try again. If VAL is embedded in another page, open the dashboard URL directly.';
        return;
      }
      if(d.requiresPasswordSetup){loginError.textContent=d.message||'Password setup required';showSetupBox();return;}
      loginError.textContent=d.error||'Login failed';
    }catch(err){
      console.error('[auth-ui] login failed',err);
      loginError.textContent='Login request failed: '+(err.message||err);
    }
  });
  </script></body></html>`;
}
function setPasswordHtml(){
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Set Password</title><style>
  :root{color-scheme:dark;--navy:#14243a;--ink:#07111d;--cream:#f4efe5;--gold:#c9a45d}
  *{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:linear-gradient(180deg,var(--navy),var(--ink));color:var(--cream);font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;padding:24px}
  .card{width:min(420px,100%);border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.055);border-radius:14px;padding:30px;box-shadow:0 24px 80px rgba(0,0,0,.28)}
  h1{font-family:Georgia,serif;font-size:34px;letter-spacing:.04em;margin:0 0 8px}.sub{color:rgba(244,239,229,.68);line-height:1.5;margin:0 0 24px}
  label{display:block;font-size:12px;text-transform:uppercase;letter-spacing:.16em;color:var(--gold);margin:16px 0 8px}
  input{width:100%;border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.08);color:var(--cream);border-radius:10px;padding:13px 14px;font-size:15px;outline:none}
  button{width:100%;margin-top:22px;border:1px solid rgba(201,164,93,.55);background:rgba(201,164,93,.18);color:var(--cream);border-radius:10px;padding:13px 14px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;cursor:pointer}
  .err{min-height:22px;color:#ffb4a8;margin-top:14px;font-size:14px}.msg{color:rgba(244,239,229,.78);font-size:14px;line-height:1.5;margin-top:14px}
  </style></head><body><form class="card" id="setPasswordForm"><h1>Set Your Password</h1><p class="sub">Choose a password for your private VAL dashboard. Minimum 10 characters.</p><label>New Password</label><input id="password" type="password" autocomplete="new-password" minlength="10" required><label>Confirm Password</label><input id="confirmPassword" type="password" autocomplete="new-password" minlength="10" required><button type="submit">Save Password</button><div class="err" id="err"></div><div class="msg" id="msg"></div></form><script>
  const token=new URLSearchParams(location.search).get('token')||'';
  const passwordInput=document.getElementById('password');
  const confirmPasswordInput=document.getElementById('confirmPassword');
  const setPasswordError=document.getElementById('err');
  const setPasswordMsg=document.getElementById('msg');
  document.getElementById('setPasswordForm').addEventListener('submit',async function(e){
    e.preventDefault();setPasswordError.textContent='';setPasswordMsg.textContent='';
    console.log('[auth-ui] set-password submit',{hasToken:!!token});
    if(passwordInput.value.length<10){setPasswordError.textContent='Password must be at least 10 characters.';return;}
    if(passwordInput.value!==confirmPasswordInput.value){setPasswordError.textContent='Passwords do not match.';return;}
    try{
      const r=await fetch('/api/auth/set-password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token,password:passwordInput.value})});
      const d=await r.json().catch(()=>({}));
      console.log('[auth-ui] set-password response',{status:r.status,ok:r.ok,error:d.error||''});
      if(r.ok&&d.ok){setPasswordMsg.textContent='Password saved. Opening VAL...';location.href='/dashboard';return;}
      setPasswordError.textContent=d.error||'This setup link is invalid or expired.';
    }catch(err){
      console.error('[auth-ui] set-password failed',err);
      setPasswordError.textContent='Password setup request failed: '+(err.message||err);
    }
  });
  </script></body></html>`;
}
function isPublicPath(req){
  const p=req.path;
  if(p==='/api/val/transcripts'&&req.method==='POST'&&isValidTranscriptWebhookReq(req)) return true;
  if(p==='/api/val/transcripts/ping'&&req.method==='POST') return true;
  return p==='/api/health'||p==='/health'||p==='/login'||p==='/set-password'||p==='/api/auth/login'||p==='/api/auth/logout'||p==='/api/auth/me'||p==='/api/auth/request-password-setup'||p==='/api/auth/set-password'||p==='/favicon.ico';
}
async function requireAuth(req,res,next){
  if(isPublicPath(req)) return next();
  if(DEMO_MODE){
    const user=demoUser();
    const state=demoState(req,res);
    req.valUser=user;
    return requestContext.run({user,demo:true,demoState:state},()=>next());
  }
  await valDbReady;
  const user=await getSessionUser(req);
  if(user){req.valUser=user;return requestContext.run({user},()=>next());}
  if(req.path.startsWith('/api/')) return res.status(401).json({ok:false,error:'Authentication required'});
  return res.redirect('/login');
}

// ── HEALTH ───────────────────────────────────────────────
function clientIsolationWarnings(){
  const warnings=[];
  if(!process.env.VAL_CLIENT_SLUG) warnings.push(`VAL_CLIENT_SLUG is missing. Using derived slug "${CLIENT_CONFIG.clientSlug}". Set an explicit unique slug in Railway.`);
  if(!process.env.VAL_CLIENT_NAME) warnings.push('VAL_CLIENT_NAME is missing. Dashboard may show generic client identity.');
  if(!process.env.VAL_CLIENT_BRAND_NAME) warnings.push('VAL_CLIENT_BRAND_NAME is missing. Dashboard may show generic brand identity.');
  if(process.env.VAL_PUBLIC_BASE_URL && process.env.VAL_PUBLIC_BASE_URL!==CLIENT_CONFIG.publicBaseUrl) warnings.push(`VAL_PUBLIC_BASE_URL was normalized from "${process.env.VAL_PUBLIC_BASE_URL}" to "${CLIENT_CONFIG.publicBaseUrl}". Fix the Railway variable.`);
  if(!process.env.DATABASE_URL) warnings.push('DATABASE_URL is missing. Deployment will use temporary file storage and is not safe for production.');
  if(CLIENT_CONFIG.clientSlug==='val-core') warnings.push('Client slug is still val-core. This is unsafe for production client isolation.');
  if(process.env.GOOGLE_REFRESH_TOKEN) warnings.push('GOOGLE_REFRESH_TOKEN is set. Remove it from Railway and reconnect Google through the dashboard so OAuth is tenant/user scoped.');
  return warnings;
}

function statusPayload(){
  return {
    status:'VAL Proxy OK',
    app:CLIENT_CONFIG.clientSlug,
    time:new Date().toISOString(),
    client:CLIENT_CONFIG,
    isolationWarnings:clientIsolationWarnings(),
    config:{
      ghlConfigured:!!(GHL_KEY&&GHL_LOC),
      ghlMissing:[GHL_KEY?'':'GHL_KEY/GHL_API_KEY',GHL_LOC?'':'GHL_LOC/GHL_LOCATION_ID'].filter(Boolean),
      openAiConfigured:!!OPENAI_KEY,
      databaseConfigured:!!process.env.DATABASE_URL,
      googleConfigured:!!(GOOGLE_CLIENT_ID&&GOOGLE_CLIENT_SECRET),
      microsoftConfigured:!!(MICROSOFT_CLIENT_ID&&MICROSOFT_CLIENT_SECRET&&MICROSOFT_REDIRECT_URI),
      ghlCalendarMode:GHL_CALENDAR_IDS.length?'selected':'all',
      ghlCalendarCount:GHL_CALENDAR_IDS.length,
      ghlAccountCount:configuredGhlAccounts().length,
      ghlAccounts:configuredGhlAccounts().map(a=>({slug:a.slug,label:a.label,locationId:a.locationId,calendarCount:a.calendarIds.length})),
      leadSearchMax:GOALL_LEAD_SEARCH_MAX,
      leadContactValidation:'strict-v1',
      demoMode:DEMO_MODE
    }
  };
}

app.get('/',async(req,res)=>{
  if(DEMO_MODE) return res.redirect('/guide');
  await valDbReady;
  const user=await getSessionUser(req);
  if(!user) return res.type('html').send(loginHtml());
  return res.sendFile(path.join(__dirname,'dashboard.html'));
});
app.get('/api/health',(req,res)=>res.json(statusPayload()));
app.get('/health',(req,res)=>res.json(statusPayload()));
app.get('/login',async(req,res)=>{
  if(DEMO_MODE) return res.redirect('/guide');
  await valDbReady;
  const user=await getSessionUser(req);
  if(user) return res.redirect('/dashboard');
  res.type('html').send(loginHtml());
});
app.get('/set-password',(req,res)=>{
  res.type('html').send(setPasswordHtml());
});
app.post('/api/auth/login',async(req,res)=>{
  await valDbReady;
  const email=String(req.body.email||'').trim().toLowerCase();
  authLog('login requested',{email});
  const user=await findUserByEmail(email);
  if(!user){authLog('login failed: unknown email',{email});return res.status(401).json({ok:false,error:'Invalid email or password'});}
  if(!user.passwordHash){authLog('login requires password setup',{email,userId:user.id});return res.status(403).json({ok:false,requiresPasswordSetup:true,message:'Password setup required'});}
  if(!(await verifyPassword(req.body.password,user.passwordHash))){authLog('login failed: bad password',{email,userId:user.id});return res.status(401).json({ok:false,error:'Invalid email or password'});}
  const sessionId=await createSession(user.id);
  setSessionCookie(res,sessionId);
  authLog('login succeeded',{email,userId:user.id});
  res.json({ok:true,user:publicUser(user),redirectUrl:'/dashboard'});
});
app.post('/api/auth/request-password-setup',async(req,res)=>{
  await valDbReady;
  const email=String(req.body.email||'').trim().toLowerCase();
  const generic={ok:true,message:'If that email exists, a setup link has been created.'};
  authLog('password setup requested',{email,hasEmail:!!email});
  if(!email) return res.status(400).json({ok:false,error:'Email is required'});
  const user=await findUserByEmail(email);
  if(!user){
    authLog('password setup requested for unknown email',{email});
    return res.json(generic);
  }
  const token=passwordSetupToken();
  const expiresAt=new Date(Date.now()+60*60*1000).toISOString();
  await storePasswordSetupToken(user.id,hashPasswordSetupToken(token),expiresAt);
  const setupUrl=passwordSetupUrlForRequest(req,token);
  authLog('password setup token generated',{email,userId:user.id,expiresAt,tokenHashPrefix:hashPasswordSetupToken(token).slice(0,10),setupUrlHost:new URL(setupUrl).host});
  res.json({...generic,setupUrl,expiresAt});
});
app.post('/api/auth/set-password',async(req,res)=>{
  await valDbReady;
  const token=String(req.body.token||'');
  const password=String(req.body.password||'');
  authLog('set password requested',{hasToken:!!token,passwordLength:password.length});
  if(!token){authLog('set password failed: missing token');return res.status(400).json({ok:false,error:'Invalid or expired setup link'});}
  if(password.length<10){authLog('set password failed: short password');return res.status(400).json({ok:false,error:'Password must be at least 10 characters'});}
  const user=await findUserByPasswordSetupToken(token);
  if(!user){authLog('set password failed: invalid or expired token',{tokenHashPrefix:hashPasswordSetupToken(token).slice(0,10)});return res.status(400).json({ok:false,error:'Invalid or expired setup link'});}
  await setUserPassword(user.id,await hashPassword(password));
  const sessionId=await createSession(user.id);
  setSessionCookie(res,sessionId);
  authLog('set password succeeded',{email:user.email,userId:user.id});
  res.json({ok:true,user:publicUser(user),redirectUrl:'/dashboard'});
});
app.post('/api/auth/logout',async(req,res)=>{
  await destroySession(req);
  clearSessionCookie(res);
  res.json({ok:true});
});
app.get('/api/auth/me',async(req,res)=>{
  if(DEMO_MODE) return res.json({ok:true,user:demoUser(),demo:true});
  await valDbReady;
  const user=await getSessionUser(req);
  res.status(user?200:401).json(user?{ok:true,user}:{ok:false,error:'Authentication required'});
});
app.use(requireAuth);
app.get('/api/config',(req,res)=>res.json({...CLIENT_CONFIG,demoMode:DEMO_MODE,signupUrl:VAL_SIGNUP_URL,ghlAccounts:configuredGhlAccounts().map(a=>({slug:a.slug,label:a.label,locationId:a.locationId,calendarCount:a.calendarIds.length})),microsoftConfigured:!!(MICROSOFT_CLIENT_ID&&MICROSOFT_CLIENT_SECRET&&MICROSOFT_REDIRECT_URI)}));
app.get('/api/config/status',(req,res)=>res.json(statusPayload()));
app.post('/api/demo/reset',(req,res)=>res.json({ok:true,demo:true,state:resetDemoState(req,res)}));
app.get('/api/val/transcripts/webhook',async(req,res)=>{
  try{
    const [transcripts,matched]=await Promise.all([
      recentTranscripts(30).catch(()=>[]),
      countTranscriptMeetingLinks(30).catch(()=>0)
    ]);
    const latest=transcripts[0]||null;
    res.json({...transcriptWebhookInfo(req),recent30DaysCount:transcripts.length,matchedToMeetings30DaysCount:matched,lastReceivedAt:latest?.createdAt||'',lastTranscriptTitle:latest?.title||latest?.type||'',lastTranscriptId:latest?.id||''});
  }catch(e){res.status(500).json({ok:false,live:false,error:e.message});}
});
app.post('/api/val/transcripts/ping',(req,res)=>{
  if(!isValidTranscriptWebhookReq(req)) return res.status(401).json({ok:false,live:false,error:'Invalid or missing transcript webhook token'});
  res.json({ok:true,live:true,status:'live',clientName:CLIENT_CONFIG.clientName,clientSlug:CLIENT_CONFIG.clientSlug,receivedAt:new Date().toISOString(),message:'Transcript webhook is live. Use the transcript URL for real transcript payloads.'});
});
app.get('/api/integrations/credentials',async(req,res)=>{
  try{
    if(DEMO_MODE){
      return res.json({ok:true,credentials:[
        {id:'demo-openai',provider:'openai',credentialType:'api_key',maskedValue:'sk-...demo',status:'Connected',lastTestedAt:new Date().toISOString()},
        {id:'demo-ghl',provider:'ghl',credentialType:'api_key',maskedValue:'ghl-...demo',status:'Connected',lastTestedAt:new Date().toISOString()},
        {id:'demo-outs',provider:'outscraper',credentialType:'api_key',maskedValue:'out-...demo',status:'Connected',lastTestedAt:new Date().toISOString()},
        {id:'demo-rr',provider:'rocketreach',credentialType:'api_key',maskedValue:'rr-...demo',status:'Connected',lastTestedAt:new Date().toISOString()}
      ],oauth:{google:true,microsoft:true},demo:true});
    }
    const credentials=await listIntegrationCredentials(req.valUser.id);
    const oauth={
      google:!!(await loadOAuthTokens('google')),
      microsoft:!!(await loadOAuthTokens('microsoft'))
    };
    res.json({ok:true,credentials,oauth});
  }catch(e){
    res.status(500).json({ok:false,error:e.message});
  }
});
app.post('/api/integrations/credentials',async(req,res)=>{
  try{
    const provider=String(req.body.provider||'').trim().toLowerCase();
    const allowed=new Set(['openai','ghl','outscraper','apollo','rocketreach','google_oauth','microsoft_oauth']);
    if(!allowed.has(provider)) return res.status(400).json({ok:false,error:'Unsupported provider'});
    if(DEMO_MODE) return res.json({ok:true,demo:true,credentials:[{id:`demo-${provider}`,provider,credentialType:'api_key',maskedValue:'...demo',status:'Connected',lastTestedAt:new Date().toISOString()}]});
    const fields=req.body.fields||{};
    const saved=[];
    async function save(type,value,metadata){
      if(String(value||'').trim()){
        saved.push(await saveIntegrationCredential({
          userId:req.valUser.id,
          provider,
          credentialType:type,
          value:String(value).trim(),
          metadata:metadata||{},
          status:'Not tested'
        }));
      }
    }
    if(provider==='openai'){
      await save('api_key',fields.apiKey||fields.key);
      await save('preferred_model',fields.preferredModel||fields.model);
    }else if(provider==='ghl'){
      await save('api_key',fields.apiKey||fields.accessToken||fields.key);
      await save('location_id',fields.locationId);
      await save('mcp_url',fields.mcpUrl);
    }else if(provider==='outscraper'){
      await save('api_key',fields.apiKey||fields.key);
    }else if(provider==='apollo'){
      await save('api_key',fields.apiKey||fields.key);
    }else if(provider==='rocketreach'){
      await save('api_key',fields.apiKey||fields.key);
    }else{
      return res.status(400).json({ok:false,error:'Use OAuth connect buttons for Google or Microsoft'});
    }
    res.json({ok:true,credentials:saved});
  }catch(e){
    res.status(500).json({ok:false,error:e.message});
  }
});
app.delete('/api/integrations/credentials/:id',async(req,res)=>{
  try{
    if(DEMO_MODE) return res.json({ok:true,demo:true,message:'Demo credential reset.'});
    await deleteIntegrationCredential(req.params.id,req.valUser.id);
    res.json({ok:true});
  }catch(e){
    res.status(500).json({ok:false,error:e.message});
  }
});
app.post('/api/integrations/test/:provider',async(req,res)=>{
  const provider=String(req.params.provider||'').toLowerCase();
  try{
    if(DEMO_MODE) return res.json({ok:true,status:'Connected',message:`${provider} is connected in demo mode.`,demo:true});
    let ok=false, message='Not tested';
    if(provider==='openai'){
      const key=await resolveOpenAIKey();
      if(!key) throw new Error('OpenAI API key is missing');
      const r=await fetch('https://api.openai.com/v1/models',{headers:{Authorization:`Bearer ${key}`}});
      ok=r.ok; message=ok?'Connected':`Failed (${r.status})`;
    }else if(provider==='anthropic'){
      const key=await resolveAnthropicKey();
      if(!key) throw new Error('Anthropic API key is missing');
      const r=await fetch('https://api.anthropic.com/v1/models',{headers:{'x-api-key':key,'anthropic-version':'2023-06-01'}});
      ok=r.ok;message=ok?'Connected':`Failed (${r.status})`;
    }else if(provider==='ghl'){
      const loc=await resolveGhlLocationId();
      const key=await resolveIntegrationSecret('ghl','api_key',GHL_KEY);
      if(!key||!loc) throw new Error('GHL API key and Location ID are required');
      const r=await fetch(`${BASE}/locations/${encodeURIComponent(loc)}`,{headers:{Authorization:`Bearer ${key}`,Version:'2021-07-28','Content-Type':'application/json'}});
      ok=r.ok; message=ok?'Connected':`Failed (${r.status})`;
    }else if(provider==='outscraper'){
      const key=await resolveIntegrationSecret('outscraper','api_key',OUTSCRAPER_API_KEY);
      ok=!!key; message=ok?'Connected': 'Outscraper API key is missing';
    }else if(provider==='apollo'){
      const key=await resolveIntegrationSecret('apollo','api_key',APOLLO_API_KEY);
      ok=!!key; message=ok?'Connected': 'Apollo API key is missing';
    }else if(provider==='rocketreach'){
      const key=await resolveIntegrationSecret('rocketreach','api_key',ROCKETREACH_API_KEY);
      ok=!!key; message=ok?'Connected': 'RocketReach API key is missing';
    }else if(provider==='google_oauth'){
      ok=!!(await loadOAuthTokens('google')); message=ok?'Connected':'Not connected';
    }else if(provider==='microsoft_oauth'){
      ok=!!(await loadOAuthTokens('microsoft')); message=ok?'Connected':'Not connected';
    }else{
      return res.status(400).json({ok:false,error:'Unsupported provider'});
    }
    await markCredentialStatus(provider,ok?'Connected':'Failed');
    res.status(ok?200:400).json({ok,status:ok?'Connected':'Failed',message});
  }catch(e){
    await markCredentialStatus(provider,'Failed').catch(()=>{});
    res.status(500).json({ok:false,status:'Failed',error:e.message});
  }
});
app.delete('/api/integrations/oauth/:provider',async(req,res)=>{
  try{
    const provider=String(req.params.provider||'').toLowerCase();
    if(!['google','microsoft'].includes(provider)) return res.status(400).json({ok:false,error:'Unsupported OAuth provider'});
    const userId=currentUserId();
    const tenant=tenantId();
    let deleted=0;
    if(pgPool){
      const scoped=await dbQuery('delete from val_oauth_tokens where provider=$1 and tenant_id=$2 and user_id=$3',[provider,tenant,userId]);
      const legacy=await dbQuery(`
        delete from val_oauth_tokens
        where provider=$1
          and (
            tenant_id in ('default','val-core',$2)
            or client_slug in ('default','val-core',$3)
            or tokens->>'tenant_id' in ('default','val-core',$2)
            or tokens->>'client_slug' in ('default','val-core',$3)
          )
      `,[provider,tenant,CLIENT_CONFIG.clientSlug]);
      deleted=(scoped.rowCount||0)+(legacy.rowCount||0);
    }
    else{
      const store=valStore();
      store.oauthTokens=store.oauthTokens||{};
      const before=Object.keys(store.oauthTokens).length;
      delete store.oauthTokens[`${tenant}:${userId}:${provider}`];
      delete store.oauthTokens[provider];
      for(const key of Object.keys(store.oauthTokens)){
        const value=store.oauthTokens[key]||{};
        if((key.endsWith(`:${provider}`)||key===provider) && (!value.tenant_id || value.tenant_id===tenant || value.tenant_id==='default' || value.tenant_id==='val-core' || value.client_slug===CLIENT_CONFIG.clientSlug || value.client_slug==='val-core')){
          delete store.oauthTokens[key];
        }
      }
      deleted=before-Object.keys(store.oauthTokens).length;
      saveValStore(store);
    }
    if(provider==='google'){ googleTokens={}; googleTokensLoaded=true; lastGoogleAuthError='Google disconnected. Reconnect required.'; }
    res.json({ok:true,deleted});
  }catch(e){
    res.status(500).json({ok:false,error:e.message});
  }
});
app.get('/api/gmail/debug',async(req,res)=>{
  try{
    const errors=[];
    const status=await getGoogleConnectionStatus(REQUIRED_GMAIL_SCOPES);
    const scopes=status.scopes;
    const missingScopes=status.missingScopes;
    const token=await getGoogleToken();
    if(!token) errors.push(status.error||'Google token missing');
    if(missingScopes.length) errors.push('Missing Gmail scopes: '+missingScopes.join(', '));
    let profileEmail='', recentInboxCount=0, unreadCount=0, sentCount=0, sampleSubjects=[];
    if(token&&!missingScopes.includes('https://www.googleapis.com/auth/gmail.readonly')){
      const profileRes=await fetch('https://www.googleapis.com/gmail/v1/users/me/profile',{headers:{Authorization:`Bearer ${token}`}});
      const profile=await readJsonResponse(profileRes);
      if(profileRes.ok) profileEmail=profile.emailAddress||'';
      else errors.push(profile.error?.message||`Gmail profile failed (${profileRes.status})`);
      const [recent,unread,sent]=await Promise.all([
        fetchGmailMessages({query:'newer_than:7d',maxResults:25}),
        fetchGmailMessages({query:'is:unread',maxResults:25}),
        fetchGmailMessages({query:'in:sent newer_than:14d',maxResults:25})
      ]);
      recentInboxCount=(recent.emails||[]).length;
      unreadCount=(unread.emails||[]).length;
      sentCount=(sent.emails||[]).length;
      sampleSubjects=(recent.emails||[]).slice(0,5).map(e=>e.subject||'(No subject)');
      if(recent.error) errors.push(recent.error);
      if(unread.error) errors.push(unread.error);
      if(sent.error) errors.push(sent.error);
    }
    res.status(errors.length?400:200).json({ok:!errors.length,connected:!errors.length,profileEmail,hasRefreshToken:status.hasRefreshToken,scopes,missingScopes,recentInboxCount,unreadCount,sentCount,sampleSubjects,errors});
  }catch(e){
    res.status(500).json({ok:false,connected:false,missingScopes:[],errors:[e.message]});
  }
});
app.get('/api/integrations/health',async(req,res)=>{
  try{
    const errors=[];
    const googleStatus=await getGoogleConnectionStatus(GOOGLE_SCOPES);
    const scopes=googleStatus.scopes;
    const missingScopes=googleStatus.missingScopes;
    const hasRefreshToken=googleStatus.hasRefreshToken;
    const token=await getGoogleToken();
    const refreshTest=token?'passed':'failed';
    if(!token&&GOOGLE_CLIENT_ID&&GOOGLE_CLIENT_SECRET) errors.push(lastGoogleAuthError||'Google auth required');
    const now=new Date();
    const past=new Date(now);past.setDate(past.getDate()-7);
    const future=new Date(now);future.setDate(future.getDate()+7);
    const microsoftConfigured=!!(MICROSOFT_CLIENT_ID&&MICROSOFT_CLIENT_SECRET&&MICROSOFT_REDIRECT_URI);
    const microsoftSaved=await loadOAuthTokens('microsoft').catch(()=>null);
    const microsoftToken=await getMicrosoftToken().catch(e=>{errors.push('Microsoft token: '+e.message);return null;});
    const [pastCal,nextCal,outlookPastCal,outlookNextCal,recentGmail,unreadGmail,sentGmail,transcripts]=await Promise.all([
      token?fetchGoogleCalendarEvents(past,now,100).catch(e=>{errors.push('Calendar past 7 days: '+e.message);return [];}):Promise.resolve([]),
      token?fetchGoogleCalendarEvents(now,future,100).catch(e=>{errors.push('Calendar next 7 days: '+e.message);return [];}):Promise.resolve([]),
      microsoftToken?fetchOutlookCalendarEvents(past,now,100).catch(e=>{errors.push('Outlook calendar past 7 days: '+e.message);return [];}):Promise.resolve([]),
      microsoftToken?fetchOutlookCalendarEvents(now,future,100).catch(e=>{errors.push('Outlook calendar next 7 days: '+e.message);return [];}):Promise.resolve([]),
      token?fetchGmailMessages({query:'newer_than:7d',maxResults:100}).catch(e=>({emails:[],error:e.message})):Promise.resolve({emails:[]}),
      token?fetchGmailMessages({query:'is:unread',maxResults:100}).catch(e=>({emails:[],error:e.message})):Promise.resolve({emails:[]}),
      token?fetchGmailMessages({query:'in:sent newer_than:14d',maxResults:100}).catch(e=>({emails:[],error:e.message})):Promise.resolve({emails:[]}),
      recentTranscripts(7).catch(e=>{errors.push('Transcripts: '+e.message);return [];})
    ]);
    if(recentGmail.error) errors.push('Gmail recent: '+recentGmail.error);
    if(unreadGmail.error) errors.push('Gmail unread: '+unreadGmail.error);
    if(sentGmail.error) errors.push('Gmail sent: '+sentGmail.error);
    const matched=await countTranscriptMeetingLinks(7).catch(e=>{errors.push('Transcript links: '+e.message);return 0;});
    const gmailErrors=[recentGmail.error,unreadGmail.error,sentGmail.error,googleStatus.error].filter(Boolean);
    const gmailHealth={
      connected:!!token&&!missingScopes.includes('https://www.googleapis.com/auth/gmail.readonly'),
      hasReadScope:!missingScopes.includes('https://www.googleapis.com/auth/gmail.readonly'),
      hasComposeScope:!missingScopes.includes('https://www.googleapis.com/auth/gmail.compose'),
      hasRefreshToken,
      recentInboxCount:(recentGmail.emails||[]).length,
      unreadCount:(unreadGmail.emails||[]).length,
      sentCount:(sentGmail.emails||[]).length,
      lastSyncAt:new Date().toISOString(),
      errors:gmailErrors
    };
    const docsMissingScopes=missingGoogleScopes(REQUIRED_GOOGLE_DOC_SCOPES);
    const docsHealth={
      connected:!!token&&docsMissingScopes.length===0,
      hasDriveFileScope:!docsMissingScopes.includes('https://www.googleapis.com/auth/drive.file'),
      hasDocumentsScope:!docsMissingScopes.includes('https://www.googleapis.com/auth/documents'),
      missingScopes:docsMissingScopes,
      error:docsMissingScopes.length?'Reconnect Google to grant Drive/Docs permissions.':''
    };
    res.json({
      ok:!errors.length,
      gmail:gmailHealth,
      google:{
        connected:!!token&&missingScopes.length===0,
        hasRefreshToken,
        scopes,
        missingScopes,
        tokenExpiresAt:googleTokenExpiresAt(),
        refreshTest,
        calendar:{enabled:!!token,past7DaysCount:pastCal.length,next7DaysCount:nextCal.length},
        gmail:{enabled:gmailHealth.connected,hasReadScope:gmailHealth.hasReadScope,hasComposeScope:gmailHealth.hasComposeScope,unreadCount:gmailHealth.unreadCount,recent7DaysCount:gmailHealth.recentInboxCount,sent14DaysCount:gmailHealth.sentCount,lastSyncAt:gmailHealth.lastSyncAt,errors:gmailHealth.errors},
        docs:{enabled:docsHealth.connected,hasDriveFileScope:docsHealth.hasDriveFileScope,hasDocumentsScope:docsHealth.hasDocumentsScope,missingScopes:docsHealth.missingScopes,error:docsHealth.error}
      },
      microsoft:{
        configured:microsoftConfigured,
        connected:!!microsoftToken,
        hasRefreshToken:!!microsoftSaved?.refresh_token,
        refreshTest:microsoftToken?'passed':'failed',
        scopes:String(microsoftSaved?.scope||MICROSOFT_SCOPES.join(' ')).split(/\s+/).filter(Boolean),
        tokenExpiresAt:microsoftSaved?.issued_at&&microsoftSaved?.expires_in?new Date((Number(microsoftSaved.issued_at)||0)+(Number(microsoftSaved.expires_in)||3600)*1000).toISOString():'',
        calendar:{enabled:!!microsoftToken,past7DaysCount:outlookPastCal.length,next7DaysCount:outlookNextCal.length}
      },
      transcripts:{last7DaysCount:transcripts.length,matchedToMeetingsCount:matched},
      actions:{canCreateTasks:true,canCreateDrafts:true,canCreateGoogleDocs:docsHealth.connected},
      errors
    });
  }catch(e){
    res.status(500).json({ok:false,error:e.message,errors:[e.message]});
  }
});
app.get('/api/email/intelligence',async(req,res)=>{
  try{
    if(DEMO_MODE){
      const s=demoState(req,res), emails=s.emails||[];
      const buckets=emails.reduce((acc,email)=>{acc[email.classification]=(acc[email.classification]||0)+1;return acc;},{});
      return res.json({ok:true,needsAttention:emails.filter(e=>e.classification==='needs_attention'),needsReply:emails.filter(e=>e.classification==='needs_reply'),lowPriority:[],waitingOnResponse:emails.filter(e=>e.classification==='waiting_on_response'),draftSuggestions:emails.filter(e=>['needs_reply','appointment_recap_needed'].includes(e.classification)),providers:{gmail:{status:'connected',needsAuth:false,missingScopes:[],error:''},outlook:{status:'connected',needsAuth:false,error:''}},errors:[],emails,summary:{total:emails.length,buckets,draftsPrepared:2,waitingOnResponse:1,forwardingSuggestions:0,ignoredLowPriority:0,ruleSuggestions:2,savedRules:1},rules:[{id:'demo-rule-1',ruleName:'Draft replies for investor requests',ruleType:'draft_reply',isActive:true}]});
    }
    const rules=await listEmailRules(req.valUser.id);
    const limit=Number(req.query.limit)||20;
    const gmailStatus=await getGoogleConnectionStatus(['https://www.googleapis.com/auth/gmail.readonly']);
    const composeStatus=await getGoogleConnectionStatus(['https://www.googleapis.com/auth/gmail.compose']);
    if(!gmailStatus.connected){
      return res.status(400).json({
        ok:false,
        source:'gmail',
        errors:[gmailStatus.error||'Gmail is not connected or missing required scopes.'],
        missingScopes:gmailStatus.missingScopes,
        needsAttention:[],needsReply:[],waitingOnResponse:[],lowPriority:[],draftSuggestions:[],relationshipContext:[]
      });
    }
    const [recentGmail,unreadGmail,sentGmail,outlook]=await Promise.all([
      fetchGmailMessages({query:'newer_than:7d',maxResults:limit,includeBody:true}).catch(e=>({emails:[],needsAuth:/google auth/i.test(e.message),error:e.message,provider:'gmail'})),
      fetchGmailMessages({query:'is:unread',maxResults:limit,includeBody:true}).catch(e=>({emails:[],needsAuth:/google auth/i.test(e.message),error:e.message,provider:'gmail'})),
      fetchGmailMessages({query:'in:sent newer_than:14d',maxResults:Math.max(limit,50),includeBody:true}).catch(e=>({emails:[],needsAuth:/google auth/i.test(e.message),error:e.message,provider:'gmail'})),
      fetchUnifiedOutlookEmails(limit).catch(e=>({emails:[],needsAuth:true,error:e.message,provider:'outlook'}))
    ]);
    const gmailMap=new Map();
    [...(recentGmail.emails||[]),...(unreadGmail.emails||[])].forEach(e=>gmailMap.set(e.messageId,e));
    const sentWaiting=waitingOnResponseFromSent(sentGmail.emails||[],Array.from(gmailMap.values()),3);
    const emails=[...Array.from(gmailMap.values()),...sentWaiting,...(outlook.emails||[])].map(email=>{
      if(email.classification==='waiting_on_response') return email;
      const c=classifyEmail(email,rules);
      return {...email,...c,matchedRuleId:c.matchedRuleId||'',matchedContact:email.matchedContact||{}};
    });
    await Promise.all(emails.slice(0,20).map(email=>logEmailAction(req.valUser.id,{provider:email.provider,messageId:email.messageId,threadId:email.threadId,actionType:'classified',actionStatus:'suggested',actedBy:'val',ruleId:email.matchedRuleId,details:{classification:email.classification,confidence:email.confidence,reason:email.reason}}).catch(()=>{})));
    const buckets=emails.reduce((acc,email)=>{acc[email.classification]=(acc[email.classification]||0)+1;return acc;},{});
    const draftsPrepared=emails.filter(e=>e.classification==='needs_reply'||e.classification==='appointment_recap_needed').length;
    const waitingOnResponse=emails.filter(e=>e.classification==='waiting_on_response').length;
    const forwardingSuggestions=emails.filter(e=>e.classification==='forward_to_team').length;
    const ignoredLowPriority=emails.filter(e=>['ignored','low_priority','solicitation','spam_like'].includes(e.classification)).length;
    res.json({
      ok:true,
      source:'gmail',
      needsAttention:emails.filter(e=>e.classification==='needs_attention'),
      needsReply:emails.filter(e=>e.classification==='needs_reply'),
      lowPriority:emails.filter(e=>['ignored','low_priority','solicitation','spam_like'].includes(e.classification)),
      waitingOnResponse:emails.filter(e=>e.classification==='waiting_on_response'),
      draftSuggestions:emails.filter(e=>e.classification==='needs_reply'||e.classification==='appointment_recap_needed'),
      relationshipContext:emails.filter(e=>e.classification==='relationship_context'||/\b(intro|introduction|proposal|meeting|follow up|partnership|client|referral)\b/i.test([e.subject,e.bodyPreview,e.snippet].join(' '))).slice(0,20),
      providers:{gmail:{status:(recentGmail.needsAuth||unreadGmail.needsAuth||sentGmail.needsAuth)?'reconnect_required':'connected',needsAuth:!!(recentGmail.needsAuth||unreadGmail.needsAuth||sentGmail.needsAuth),missingScopes:(gmailStatus.missingScopes||[]).concat(composeStatus.missingScopes||[]),hasComposeScope:composeStatus.connected,error:recentGmail.error||unreadGmail.error||sentGmail.error||'',recentInboxCount:(recentGmail.emails||[]).length,unreadCount:(unreadGmail.emails||[]).length,sentCount:(sentGmail.emails||[]).length,lastSyncAt:new Date().toISOString()},outlook:{needsAuth:!!outlook.needsAuth,error:outlook.error||'',status:outlook.needsAuth?'not_connected':'connected'}},
      errors:[recentGmail.error,unreadGmail.error,sentGmail.error,outlook.error,composeStatus.connected?'':'Gmail compose scope missing. Drafts will be saved internally until Google is reconnected.'].filter(Boolean),
      emails,
      summary:{total:emails.length,buckets,draftsPrepared,waitingOnResponse,forwardingSuggestions,ignoredLowPriority,ruleSuggestions:0,savedRules:rules.filter(r=>r.isActive!==false).length},
      rules
    });
  }catch(e){
    res.status(500).json({ok:false,error:e.message});
  }
});
app.get('/api/email/rules',async(req,res)=>{
  try{res.json({ok:true,rules:await listEmailRules(req.valUser.id)});}
  catch(e){res.status(500).json({ok:false,error:e.message});}
});
app.post('/api/email/rules',async(req,res)=>{
  try{
    const rule=await saveEmailRule(req.valUser.id,req.body||{});
    await logEmailAction(req.valUser.id,{provider:rule.provider,actionType:'rule_created',actionStatus:'created',actedBy:'user',ruleId:rule.id,details:rule});
    res.json({ok:true,rule});
  }catch(e){res.status(500).json({ok:false,error:e.message});}
});
app.patch('/api/email/rules/:id',async(req,res)=>{
  try{
    const rules=await listEmailRules(req.valUser.id);
    const existing=rules.find(r=>r.id===req.params.id);
    if(!existing)return res.status(404).json({ok:false,error:'Rule not found'});
    const rule=await saveEmailRule(req.valUser.id,{...existing,...req.body,id:req.params.id});
    res.json({ok:true,rule});
  }catch(e){res.status(500).json({ok:false,error:e.message});}
});
app.post('/api/email/actions',async(req,res)=>{
  try{
    const body=req.body||{};
    const action=String(body.actionType||body.action||'').trim();
    const email=body.email||{};
    const sensitive=/legal|hr|medical|financial|contract|complaint|confidential/i.test([email.subject,email.bodyPreview,email.bodyText].join(' '));
    const external=['send','forward','delete','archive','marked_read'].includes(action);
    const status=(external||sensitive)?'needs_approval':'prepared';
    const result={ok:true,status,requiresApproval:status==='needs_approval'};
    if(action==='drafted_reply'||action==='draft_reply'){
      result.draft={subject:'Re: '+(email.subject||''),body:`Hi ${email.from?.name||''},\n\nThank you for your note. I wanted to respond thoughtfully.\n\n[VAL draft: review and personalize before sending.]\n\nBest,`};
      result.internalDraft=await saveInternalDraft({draftType:'email_reply',provider:'internal',subject:result.draft.subject,body:result.draft.body,sourceContext:{source:'email_intelligence',messageId:email.messageId,threadId:email.threadId,from:email.from}});
    }else if(action==='forwarded'||action==='forward'){
      result.forwardDraft={to:body.forwardTo||'',subject:'Fwd: '+(email.subject||''),body:`VAL summary:\n${email.reason||'This may need review.'}\n\nOriginal email below.\n\nFrom: ${email.from?.email||''}\nSubject: ${email.subject||''}\n\n${email.bodyPreview||email.snippet||''}`};
      result.internalDraft=await saveInternalDraft({draftType:'email_forward',provider:'internal',subject:result.forwardDraft.subject,body:result.forwardDraft.body,sourceContext:{source:'email_intelligence',messageId:email.messageId,threadId:email.threadId,forwardTo:result.forwardDraft.to}});
    }else if(action==='followup_tracked'||action==='track_response'){
      result.followup={title:'Follow up on '+(email.subject||'email'),dueInBusinessDays:3};
      const due=new Date();due.setDate(due.getDate()+3);
      result.task={id:uuid('task'),title:result.followup.title,contactName:email.from?.name||email.from?.email||'',dueDate:due.toISOString(),notes:'Created from Email Intelligence waiting-on-response tracking.',details:[{text:'Source email: '+(email.subject||''),ts:new Date().toISOString()}],completed:false,createdAt:new Date().toISOString()};
      await saveTask(result.task);
    }else if(action==='task_created'||action==='add_task'){
      result.task={id:uuid('task'),title:'Review email: '+(email.subject||'(No subject)'),contactName:email.from?.name||email.from?.email||'',dueDate:null,notes:[email.reason||'',email.recommendedAction||'',email.bodyPreview||email.snippet||''].filter(Boolean).join('\n'),details:[{text:'Created from Email Intelligence',ts:new Date().toISOString()}],completed:false,createdAt:new Date().toISOString()};
      await saveTask(result.task);
    }
    await logEmailAction(req.valUser.id,{provider:email.provider,messageId:email.messageId,threadId:email.threadId,actionType:action||'suggested',actionStatus:status,actedBy:'user',ruleId:email.matchedRuleId||'',details:{email,body,result}});
    res.json(result);
  }catch(e){res.status(500).json({ok:false,error:e.message});}
});
app.post('/api/email/automation-rule',async(req,res)=>{
  try{
    const email=req.body.email||{};
    const mode=req.body.mode||'auto_next_time';
    const action=req.body.action||email.recommendedAction||'label';
    const fromEmail=email.from?.email||'';
    const domain=fromEmail.split('@')[1]||'';
    let ruleType='label',conditions={},actions={action:'label',label:email.classification||'review'};
    if(mode==='ignore_sender'||mode==='ignore_domain'){
      ruleType=mode;conditions=mode==='ignore_domain'?{from_domain:domain}:{from_email:fromEmail};actions={action:'label',label:'low_priority'};
    }else if(/forward/i.test(action)){
      ruleType='forward_sender';conditions={from_email:fromEmail};actions={action:'forward',forward_to:req.body.forwardTo||'',include_summary:true,cc_user:false};
    }else if(/reply|draft/i.test(action)){
      ruleType='draft_reply';conditions={from_email:fromEmail};actions={action:'draft_reply'};
    }else if(/track/i.test(action)){
      ruleType='track_sent_followup';conditions={from_email:fromEmail||'',subject_contains:(email.subject||'').slice(0,80)};actions={action:'track_response',business_days:3};
    }
    if(!conditions.from_email&&!conditions.from_domain&&!conditions.subject_contains)return res.status(400).json({ok:false,error:'Rule trigger is too broad. Confirmation needs a specific sender, domain, or subject pattern.'});
    const rule=await saveEmailRule(req.valUser.id,{provider:email.provider||'any',ruleName:req.body.ruleName||`Auto ${ruleType} for ${conditions.from_email||conditions.from_domain||conditions.subject_contains}`,ruleType,conditions,actions,approvalMode:req.body.approvalMode||'always_auto',confidenceThreshold:'high',createdFrom:'user_confirmation',createdFromMessageId:email.messageId||'',createdFromThreadId:email.threadId||''});
    await logEmailAction(req.valUser.id,{provider:email.provider,messageId:email.messageId,threadId:email.threadId,actionType:'rule_created',actionStatus:'created',actedBy:'user',ruleId:rule.id,details:{rule}});
    res.json({ok:true,rule});
  }catch(e){res.status(500).json({ok:false,error:e.message});}
});
app.post('/api/email/rule-suggestions/analyze',async(req,res)=>{
  try{
    const actions=req.body.recentEmailActions||await recentEmailActions(req.valUser.id,200);
    const existing=req.body.existingRules||await listEmailRules(req.valUser.id);
    const suggestions=[];
    const forwardCounts={};
    const ignoreCounts={};
    actions.forEach(a=>{
      const d=a.details_json||a.details||{};
      const from=d.email?.from?.email||d.from_email||'';
      const forwardTo=d.body?.forwardTo||d.forward_to||'';
      if(from&&forwardTo)forwardCounts[from+'>'+forwardTo]=(forwardCounts[from+'>'+forwardTo]||0)+1;
      if(from&&['ignored','low_priority'].includes(d.classification||d.email?.classification))ignoreCounts[from]=(ignoreCounts[from]||0)+1;
    });
    Object.entries(forwardCounts).filter(([,n])=>n>=2).slice(0,5).forEach(([key,n])=>{
      const [from,to]=key.split('>');
      suggestions.push({suggestedRuleType:'forward_sender',plainEnglish:`I noticed you often forward emails from ${from} to ${to}.`,conditions:{from_email:from},actions:{action:'forward',forward_to:to,include_summary:true,cc_user:false},confidence:n>=3?'high':'medium',evidence:[`${n} similar forwarding actions`],confirmationQuestion:`Should VAL automatically forward future emails from ${from} to ${to}?`});
    });
    Object.entries(ignoreCounts).filter(([,n])=>n>=2).slice(0,5).forEach(([from,n])=>{
      suggestions.push({suggestedRuleType:'ignore_sender',plainEnglish:`You repeatedly ignore or downgrade emails from ${from}.`,conditions:{from_email:from},actions:{action:'label',label:'low_priority'},confidence:n>=3?'high':'medium',evidence:[`${n} ignored or low priority actions`],confirmationQuestion:`Should VAL move future emails from ${from} into low priority automatically?`});
    });
    res.json({ok:true,suggestions,existingRules:existing.length});
  }catch(e){res.status(500).json({ok:false,error:e.message});}
});
function guideHtml(markdown){
  const slug = text => String(text||'').toLowerCase().replace(/<[^>]+>/g,'').replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
  const referenceMd = String(markdown||'').slice(Math.max(0,String(markdown||'').indexOf('## 1. Core Concept')));
  const escaped = referenceMd.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const referenceHtml = escaped
    .replace(/^# (.+)$/gm,(_,t)=>`<h1 id="${slug(t)}">${t}</h1>`)
    .replace(/^## (.+)$/gm,(_,t)=>`<h2 id="${slug(t)}">${t}</h2>`)
    .replace(/^### (.+)$/gm,(_,t)=>`<h3 id="${slug(t)}">${t}</h3>`)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g,'<a href="$2">$1</a>')
    .replace(/`([^`]+)`/g,'<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>')
    .replace(/^- (.+)$/gm,'<li>$1</li>')
    .replace(/^\d+\. (.+)$/gm,'<li>$1</li>')
    .replace(/\n\n/g,'</p><p>')
    .replace(/\n/g,'<br>');
  const icon = {
    calendar:'<svg viewBox="0 0 24 24"><path d="M7 3v3M17 3v3M4 9h16M6 5h12a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z"/></svg>',
    radar:'<svg viewBox="0 0 24 24"><path d="M12 21a9 9 0 1 0-9-9"/><path d="M12 12 19 5"/><path d="M8 12a4 4 0 1 0 4-4"/></svg>',
    stack:'<svg viewBox="0 0 24 24"><path d="M7 7h10M7 12h10M7 17h6"/><path d="M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z"/></svg>',
    node:'<svg viewBox="0 0 24 24"><path d="M8 8h8v8H8z"/><path d="M4 4h4v4H4zM16 4h4v4h-4zM4 16h4v4H4zM16 16h4v4h-4z"/></svg>',
    voice:'<svg viewBox="0 0 24 24"><path d="M4 12v2M8 8v8M12 5v14M16 8v8M20 12v2"/></svg>'
  };
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>VAL Guide</title><style>
:root{--bg:#111827;--panel:#182336;--panel2:#1f2d43;--text:#f8f5ee;--muted:#b8c0cc;--gold:#d7b56d;--line:rgba(255,255,255,.1)}
*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at top,#1f2d43 0,#111827 48%);color:var(--text);font-family:Inter,Arial,sans-serif;line-height:1.55}a{color:inherit}.top{position:sticky;top:0;z-index:10;background:rgba(17,24,39,.82);backdrop-filter:blur(14px);border-bottom:1px solid var(--line);padding:14px 22px}.top a{color:var(--gold);text-decoration:none;font-size:12px;text-transform:uppercase;letter-spacing:.12em}.wrap{max-width:1120px;margin:0 auto;padding:54px 22px 90px}.hero{min-height:340px;display:grid;align-items:end;padding:42px 0 36px;border-bottom:1px solid var(--line)}.eyebrow{font-size:12px;letter-spacing:.16em;text-transform:uppercase;color:var(--gold);font-weight:700}.hero h1{font-family:Georgia,serif;font-size:clamp(48px,9vw,112px);line-height:.9;margin:12px 0}.hero p{font-size:20px;color:var(--muted);max-width:620px;margin:0 0 24px}.actions{display:flex;gap:12px;flex-wrap:wrap}.btn{display:inline-flex;align-items:center;justify-content:center;min-height:42px;padding:0 18px;border-radius:7px;border:1px solid var(--gold);background:rgba(215,181,109,.12);color:var(--gold);font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;text-decoration:none}.btn.secondary{border-color:var(--line);color:var(--text);background:rgba(255,255,255,.04)}section{margin-top:42px}.section-head{display:flex;justify-content:space-between;gap:16px;align-items:end;margin-bottom:16px}.section-head h2{font-family:Georgia,serif;font-size:30px;margin:0}.section-head p{margin:0;color:var(--muted);max-width:520px}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}.card{display:flex;flex-direction:column;gap:12px;min-height:210px;padding:20px;border:1px solid var(--line);border-radius:10px;background:linear-gradient(180deg,rgba(255,255,255,.055),rgba(255,255,255,.025));text-decoration:none;transition:.18s ease}.card:hover{transform:translateY(-2px);border-color:rgba(215,181,109,.45);background:rgba(215,181,109,.08)}.icon{width:34px;height:34px;border:1px solid rgba(215,181,109,.35);border-radius:9px;display:grid;place-items:center;color:var(--gold)}.icon svg{width:19px;height:19px;fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}.card h3{font-family:Georgia,serif;font-size:23px;margin:0}.card p{color:var(--muted);margin:0}.status{margin-top:auto;color:var(--gold);font-size:12px;text-transform:uppercase;letter-spacing:.1em}.modes{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}.mode{padding:18px;border:1px solid var(--line);border-radius:10px;background:rgba(255,255,255,.04)}.mode h3{margin:0 0 10px;font-size:15px;color:var(--gold);text-transform:uppercase;letter-spacing:.1em}.mode a{display:block;color:var(--text);text-decoration:none;padding:8px 0;border-top:1px solid rgba(255,255,255,.07)}.journey{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}.step{padding:18px;border-left:2px solid var(--gold);background:rgba(255,255,255,.04);border-radius:8px}.step span{color:var(--gold);font-size:11px;text-transform:uppercase;letter-spacing:.14em}.step h3{margin:8px 0 8px}.activity{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}.activity div{padding:16px;border:1px solid var(--line);border-radius:8px;background:rgba(255,255,255,.035);color:var(--muted)}details{border:1px solid var(--line);border-radius:10px;background:rgba(255,255,255,.035);padding:0;margin-top:12px}summary{cursor:pointer;padding:18px 20px;color:var(--gold);font-weight:700;text-transform:uppercase;letter-spacing:.1em}.reference{padding:0 22px 24px;color:#e7dcc5}.reference h1,.reference h2,.reference h3{font-family:Georgia,serif;color:var(--gold)}.reference h2{border-top:1px solid var(--line);padding-top:22px}.reference code{background:rgba(255,255,255,.08);padding:2px 5px;border-radius:5px}.reference li{margin:4px 0 4px 22px}@media(max-width:850px){.grid,.modes,.journey,.activity{grid-template-columns:1fr}.hero{min-height:280px}.card{min-height:170px}}
.dash-float{position:fixed;right:18px;bottom:18px;z-index:20;box-shadow:0 18px 50px rgba(0,0,0,.32)}
.demo-banner{border:1px solid rgba(215,181,109,.35);background:rgba(215,181,109,.08);border-radius:12px;padding:14px 16px;margin-bottom:18px;color:var(--muted);display:${DEMO_MODE?'flex':'none'};gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap}.demo-banner strong{color:var(--text)}
</style></head><body><div class="top"><a href="/dashboard">Back to VAL</a></div><main class="wrap">
<a class="btn dash-float" href="/dashboard">Back To Dashboard</a>
<div class="demo-banner"><div><strong>Demo Mode</strong><br>Explore VAL with sample meetings, emails, tasks, relationships, drafts, transcripts, and pipeline data. Reset any time.</div><div class="actions"><a class="btn" href="${VAL_SIGNUP_URL}">Get Your VAL Now</a><button class="btn secondary" onclick="resetDemo()">Reset Demo</button></div></div>
<section class="hero"><div><div class="eyebrow">Velocity-Activated Leverage</div><h1>VAL</h1><p>Your executive operating layer. Never lose track of important people, promises, or opportunities again.</p><div class="actions"><a class="btn" href="/dashboard">Open Demo</a><a class="btn secondary" href="/dashboard">Run Relationship Review</a><a class="btn" href="${VAL_SIGNUP_URL}">Get Your VAL Now</a></div></div></section>
<section><div class="section-head"><div><h2>Your Priorities</h2><p>Start with the moves that create clarity fastest.</p></div></div><div class="grid">
<a class="card" href="/dashboard"><span class="icon">${icon.calendar}</span><h3>Prepare For Today</h3><p>Know who matters before your next conversation.</p><div class="status" id="meetingStatus">Loading meetings</div></a>
<a class="card" href="/dashboard"><span class="icon">${icon.radar}</span><h3>Relationship Review</h3><p>See who matters most, which relationships are cooling, and where hidden opportunity exists.</p><div class="status" id="radarStatus">Checking signals</div></a>
<a class="card" href="/dashboard"><span class="icon">${icon.stack}</span><h3>Approval Queue</h3><p>Review drafts, promises, and pending actions.</p><div class="status" id="queueStatus">Loading drafts</div></a>
<a class="card" href="/dashboard"><span class="icon">${icon.stack}</span><h3>Email Intelligence</h3><p>Find needed replies, waiting-on-response items, and safe draft opportunities.</p><div class="status">Review inbox signals</div></a>
<a class="card" href="/dashboard"><span class="icon">${icon.node}</span><h3>Integration Status</h3><p>Check Gmail, Calendar, transcripts, tasks, drafts, and missing permissions.</p><div class="status">Verify data pipes</div></a>
<a class="card" href="/dashboard"><span class="icon">${icon.node}</span><h3>Register Your Keys</h3><p>Securely add client-owned keys and connection details inside VAL.</p><div class="status">Encrypted setup</div></a>
</div></section>
<section><div class="section-head"><div><h2>Your First 3 Minutes</h2><p>A short path that helps VAL understand you and start creating momentum.</p></div></div><div class="journey"><div class="step"><span>Step 1</span><h3>Personalize VAL</h3><p>Tell VAL who you are, how you work, and what relationships drive your business.</p><a class="btn secondary" href="/dashboard">Personalize VAL</a></div><div class="step"><span>Step 2</span><h3>Review Today</h3><p>See meetings, priorities, and what needs your attention before the day gets noisy.</p><a class="btn secondary" href="/dashboard">Open Today View</a></div><div class="step"><span>Step 3</span><h3>Run Relationship Review</h3><p>Find the people, promises, and opportunities most likely to create value or lose trust if ignored.</p><a class="btn secondary" href="/dashboard">Run Relationship Review</a></div></div></section>
<section><div class="section-head"><div><h2>What Do You Want To Do?</h2><p>Choose by outcome, not by feature name.</p></div></div><div class="modes"><div class="mode"><h3>Stay Ahead</h3><a href="/dashboard">Meeting Prep</a><a href="/dashboard">Daily Rhythm</a><a href="/dashboard">Calendar Intelligence</a></div><div class="mode"><h3>Protect Relationships</h3><a href="/dashboard">Relationship Review</a><a href="/dashboard">Follow-Ups</a><a href="/dashboard">Contact Command Center</a></div><div class="mode"><h3>Clear Mental Load</h3><a href="/dashboard">Approval Queue</a><a href="/dashboard">Drafts</a><a href="/dashboard">Tasks By Relationship</a></div><div class="mode"><h3>Trust The System</h3><a href="/dashboard">Email Intelligence</a><a href="/dashboard">Integration Status</a><a href="/dashboard">Register Your Keys</a></div></div></section>
<section><div class="section-head"><div><h2>Recent Activity</h2><p>VAL should feel alive. These signals update from your workspace.</p></div></div><div class="activity"><div id="activityMeetings">Meetings loading</div><div id="activityTasks">Tasks loading</div><div id="activityFollowups">Follow-ups loading</div></div></section>
<section><div class="section-head"><div><h2>Learn VAL</h2><p>The full reference is here when you want depth. You do not need to study it first.</p></div></div><details><summary>See Full Reference</summary><div class="reference"><p>${referenceHtml}</p></div></details></section>
</main><script>
async function json(url){try{const r=await fetch(url);return r.ok?await r.json():null}catch(e){return null}}
function set(id,text){const el=document.getElementById(id);if(el)el.textContent=text}
(async()=>{
  const [tasks,cal,comms,props]=await Promise.all([json('/api/val/tasks'),json('/api/calendar'),json('/api/comms'),json('/api/proposals')]);
  const open=Array.isArray(tasks)?tasks.filter(t=>!t.completed):[];
  const overdue=open.filter(t=>t.dueDate&&new Date(t.dueDate)<new Date());
  const events=(cal&&cal.calendarEvents)||[];
  const today=events.filter(e=>{const raw=e.startTime||e.date||(e.start&&(e.start.dateTime||e.start.date));return raw&&new Date(raw).toDateString()===new Date().toDateString()});
  const unread=(comms&&comms.total)||0;
  const drafts=(props&&props.draft)||0;
  set('meetingStatus',today.length?today.length+' meetings today':'No meetings today');
  set('radarStatus',(unread+overdue.length)?(unread+overdue.length)+' signals need attention':'All clear right now');
  set('queueStatus',drafts?drafts+' drafts waiting':'No drafts waiting');
  set('activityMeetings',today.length?today.length+' meetings on deck':'Calendar is clear today');
  set('activityTasks',overdue.length?overdue.length+' overdue tasks':open.length+' open tasks');
  set('activityFollowups',unread?unread+' unread conversations':'No unread conversations');
})();
async function resetDemo(){await fetch('/api/demo/reset',{method:'POST'});location.href='/guide';}
</script></body></html>`;
}
app.get('/guide',(req,res)=>{
  const file = path.join(__dirname,'VAL_USER_GUIDE.md');
  fs.readFile(file,'utf8',(err,markdown)=>{
    if(err) return res.status(404).send('VAL guide not found.');
    res.type('html').send(guideHtml(markdown));
  });
});
app.use(express.static(__dirname));
app.get('/dashboard',(req,res)=>res.sendFile(path.join(__dirname,'dashboard.html')));

// ════════════════════════════════════════════════════════
// GOOGLE OAUTH
// ════════════════════════════════════════════════════════

const GOOGLE_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI         = process.env.GOOGLE_REDIRECT_URI || process.env.REDIRECT_URI || `${CLIENT_CONFIG.publicBaseUrl}/auth/callback`;
const DEFAULT_GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/documents'
];
const GOOGLE_SCOPES = String(process.env.GOOGLE_SCOPES||'').trim()
  ? Array.from(new Set(String(process.env.GOOGLE_SCOPES).split(/\s+/).map(s=>s.trim()).filter(Boolean).concat([
      'https://www.googleapis.com/auth/drive.readonly',
      'https://www.googleapis.com/auth/drive.file',
      'https://www.googleapis.com/auth/documents'
    ])))
  : DEFAULT_GOOGLE_SCOPES;
const REQUIRED_GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose'
];
const REQUIRED_GOOGLE_DOC_SCOPES = [
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/documents'
];
let googleTokens = {}; // hot cache; durable copy lives in Postgres scoped by tenant/user.
let googleTokensLoaded = false;
let lastGoogleAuthError = null;

// Optional legacy fallback only. Prefer OAuth reconnect so tokens are scoped to this VAL tenant/user.
if(process.env.GOOGLE_REFRESH_TOKEN && /^(1|true|yes)$/i.test(String(process.env.ALLOW_GOOGLE_REFRESH_TOKEN_ENV||''))){
  googleTokens.refresh_token = process.env.GOOGLE_REFRESH_TOKEN;
  googleTokens.issued_at = 0; // force refresh on first use
  console.log('Loaded Google refresh token from env var because ALLOW_GOOGLE_REFRESH_TOKEN_ENV is enabled');
}

async function saveOAuthTokens(provider,tokens){
  if(!tokens||!Object.keys(tokens).length) return;
  const userId=currentUserId();
  const tenant=tenantId();
  const scopedTokens={...tokens,user_id:userId,tenant_id:tenant,client_slug:CLIENT_CONFIG.clientSlug};
  if(pgPool){
    await valDbReady;
    await dbQuery(`
      insert into val_oauth_tokens (provider,user_id,tenant_id,client_slug,tokens,updated_at)
      values ($1,$2,$3,$4,$5,now())
      on conflict (tenant_id,user_id,provider)
      do update set client_slug=excluded.client_slug,tokens=excluded.tokens,updated_at=now()
    `,[provider,userId,tenant,CLIENT_CONFIG.clientSlug,JSON.stringify(scopedTokens)]);
  }else{
    const store=valStore();
    store.oauthTokens=store.oauthTokens||{};
    store.oauthTokens[`${tenant}:${userId}:${provider}`]=scopedTokens;
    saveValStore(store);
  }
}

async function loadOAuthTokens(provider){
  await valDbReady;
  const userId=currentUserId();
  const tenant=tenantId();
  if(pgPool){
    const r=await dbQuery('select tokens from val_oauth_tokens where provider=$1 and tenant_id=$2 and user_id=$3 order by updated_at desc limit 1',[provider,tenant,userId]);
    return r.rows[0]?.tokens || null;
  }
  const tokens=valStore().oauthTokens||{};
  return tokens[`${tenant}:${userId}:${provider}`] || null;
}

async function ensureGoogleTokensLoaded(){
  if(googleTokensLoaded) return;
  const saved=await loadOAuthTokens('google');
  if(saved){
    googleTokens={...googleTokens,...saved};
    console.log('Loaded Google tokens from VAL store');
  }
  googleTokensLoaded = true;
}

function googleScopeList(tokens=googleTokens){
  return String(tokens?.scope||'').split(/\s+/).map(s=>s.trim()).filter(Boolean);
}
function missingGoogleScopes(required=GOOGLE_SCOPES,tokens=googleTokens){
  const scopes=new Set(googleScopeList(tokens));
  return required.filter(scope=>!scopes.has(scope));
}
function googleTokenExpiresAt(tokens=googleTokens){
  if(!tokens?.issued_at||!tokens?.expires_in) return '';
  return new Date(Number(tokens.issued_at)+Number(tokens.expires_in)*1000).toISOString();
}
async function hydrateGoogleTokenScopes(accessToken){
  if(!accessToken) return googleScopeList();
  try{
    const r=await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(accessToken)}`);
    const d=await readJsonResponse(r);
    if(r.ok&&d.scope){
      const nextScope=String(d.scope||'').trim();
      if(nextScope&&nextScope!==googleTokens.scope){
        googleTokens={...googleTokens,scope:nextScope};
        await saveOAuthTokens('google',googleTokens);
      }
      return googleScopeList();
    }
  }catch(e){}
  return googleScopeList();
}
async function getGoogleConnectionStatus(requiredScopes=GOOGLE_SCOPES){
  await ensureGoogleTokensLoaded();
  const hasRefreshToken=!!googleTokens.refresh_token;
  const token=await getGoogleToken();
  if(token) await hydrateGoogleTokenScopes(token);
  const scopes=googleScopeList();
  const missingScopes=missingGoogleScopes(requiredScopes);
  return {
    connected:!!token&&missingScopes.length===0,
    hasAccessToken:!!token,
    hasRefreshToken,
    scopes,
    missingScopes,
    tokenExpiresAt:googleTokenExpiresAt(),
    error:token ? (missingScopes.length?'Reconnect required for missing Google scopes.':'') : (lastGoogleAuthError||'Google auth required')
  };
}

// Step 1 — redirect user to Google consent screen
// ── IMAGE ANALYSIS (GPT-4o) ─────────────────────────────
app.post('/api/analyze-image',async(req,res)=>{
  try{
    const {base64,mediaType,prompt}=req.body;
    if(!base64||!mediaType) return res.status(400).json({error:'Missing base64 or mediaType'});
    const openAiKey=await resolveOpenAIKey();
    if(!openAiKey) return res.status(500).json({error:'OPENAI_KEY not configured'});
    const r=await fetch('https://api.openai.com/v1/chat/completions',{
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':`Bearer ${openAiKey}`},
      body:JSON.stringify({
        model:'gpt-4o',
        max_tokens:1000,
        messages:[{
          role:'user',
          content:[
            {type:'image_url',image_url:{url:`data:${mediaType};base64,${base64}`}},
            {type:'text',text:prompt||'Analyze this image and give detailed feedback. What do you see, what\'s working well, and what could be improved?'}
          ]
        }]
      })
    });
    const d=await r.json();
    if(d.error) return res.status(500).json({error:d.error.message});
    res.json({reply:d.choices?.[0]?.message?.content||'No response'});
  }catch(e){
    console.error('image analysis error:',e);
    res.status(500).json({error:e.message});
  }
});

// ── IMAGE GENERATION (DALL-E 3) ─────────────────────────
app.post('/api/generate-image',async(req,res)=>{
  try{
    const {prompt,size,quality}=req.body;
    if(!prompt) return res.status(400).json({error:'Missing prompt'});
    const openAiKey=await resolveOpenAIKey();
    if(!openAiKey) return res.status(500).json({error:'OPENAI_KEY not configured'});
    const r=await fetch('https://api.openai.com/v1/images/generations',{
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':`Bearer ${openAiKey}`},
      body:JSON.stringify({
        model:'dall-e-3',
        prompt,
        n:1,
        size:size||'1024x1024',
        quality:quality||'standard',
        response_format:'url'
      })
    });
    const d=await r.json();
    if(d.error) return res.status(500).json({error:d.error.message});
    const url=d.data?.[0]?.url;
    const revised=d.data?.[0]?.revised_prompt;
    res.json({url,revisedPrompt:revised});
  }catch(e){
    console.error('image generation error:',e);
    res.status(500).json({error:e.message});
  }
});
app.post('/api/claude',async(req,res)=>{
  try{
    const key=await resolveAnthropicKey();if(!key)return res.status(400).json({ok:false,error:'Connect Anthropic in Settings before using Claude.'});
    const r=await fetch('https://api.anthropic.com/v1/messages',{method:'POST',headers:{'Content-Type':'application/json','x-api-key':key,'anthropic-version':'2023-06-01'},body:JSON.stringify({model:req.body.model||'claude-sonnet-4-20250514',max_tokens:Number(req.body.max_tokens)||2000,system:req.body.system||'',messages:req.body.messages||[{role:'user',content:req.body.user||''}]})});
    const d=await r.json();if(!r.ok)return res.status(r.status).json({ok:false,error:d.error?.message||'Claude request failed'});res.json({ok:true,text:(d.content||[]).map(x=>x.text||'').join(''),usage:d.usage||{}});
  }catch(e){res.status(500).json({ok:false,error:e.message});}
});

app.get('/auth/google', (req, res) => {
  const scopes = GOOGLE_SCOPES.join(' ');
  const url = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${GOOGLE_CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=${encodeURIComponent(scopes)}&access_type=offline&prompt=consent&include_granted_scopes=true`;
  res.redirect(url);
});

// Step 2 — Google redirects back with code, exchange for tokens
app.get('/auth/callback', async (req, res) => {
  const {code} = req.query;
  if(!code) return res.status(400).send('No code received');
  try {
    const existingTokens = await loadOAuthTokens('google') || googleTokens || {};
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: {'Content-Type':'application/x-www-form-urlencoded'},
      body: new URLSearchParams({
        code, client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
        grant_type: 'authorization_code'
      })
    });
    const exchangedTokens = await r.json();
    if(exchangedTokens.error) throw new Error(exchangedTokens.error_description || exchangedTokens.error);
    googleTokens = {
      ...existingTokens,
      ...exchangedTokens,
      refresh_token: exchangedTokens.refresh_token || existingTokens.refresh_token || process.env.GOOGLE_REFRESH_TOKEN
    };
    googleTokens.issued_at = Date.now();
    googleTokensLoaded = true;
    lastGoogleAuthError = null;
    await saveOAuthTokens('google',googleTokens);
    console.log('Google tokens stored. refresh_token present:', !!googleTokens.refresh_token, 'scope count:', googleScopeList().length);
    res.send(`<h2 style="font-family:sans-serif;padding:2rem">Google Calendar, Gmail, Drive, and Docs connected to VAL.<br><br>You can close this tab.</h2>`);
  } catch(e) {
    res.status(500).send('Auth failed: '+e.message);
  }
});

// Refresh access token if expired
async function getGoogleToken() {
  await ensureGoogleTokensLoaded();
  // If no access token but we have a refresh token, go get one
  if(!googleTokens.access_token && googleTokens.refresh_token) {
    try {
      const r = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: {'Content-Type':'application/x-www-form-urlencoded'},
        body: new URLSearchParams({
          client_id: GOOGLE_CLIENT_ID,
          client_secret: GOOGLE_CLIENT_SECRET,
          refresh_token: googleTokens.refresh_token,
          grant_type: 'refresh_token'
        })
      });
      const fresh = await r.json();
      if(fresh.error){ lastGoogleAuthError = fresh.error_description || fresh.error; console.error('Token bootstrap failed:', fresh.error, fresh.error_description); return null; }
      googleTokens = {...googleTokens, ...fresh, issued_at: Date.now()};
      googleTokensLoaded = true;
      lastGoogleAuthError = null;
      await saveOAuthTokens('google',googleTokens);
      await hydrateGoogleTokenScopes(googleTokens.access_token);
      console.log('Bootstrapped access token from refresh token');
      return googleTokens.access_token;
    } catch(e) {
      console.error('Token bootstrap error:', e);
      return null;
    }
  }
  if(!googleTokens.access_token) return null;
  // Check if expired (with 60s buffer)
  const expiresAt = (googleTokens.issued_at||0) + (googleTokens.expires_in||3600)*1000 - 60000;
  if(Date.now() < expiresAt) return googleTokens.access_token;
  if(!googleTokens.refresh_token){
    lastGoogleAuthError='Google refresh token missing. Reconnect required.';
    return null;
  }
  // Refresh
  try {
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: {'Content-Type':'application/x-www-form-urlencoded'},
      body: new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        refresh_token: googleTokens.refresh_token,
        grant_type: 'refresh_token'
      })
    });
    const fresh = await r.json();
    if(fresh.error){
      lastGoogleAuthError = fresh.error_description || fresh.error;
      console.error('Google token refresh failed:', fresh.error);
      if(fresh.error==='invalid_grant') googleTokens.access_token='';
      return null;
    }
    googleTokens = {...googleTokens, ...fresh, issued_at: Date.now()};
    googleTokensLoaded = true;
    lastGoogleAuthError = null;
    await saveOAuthTokens('google',googleTokens);
    await hydrateGoogleTokenScopes(googleTokens.access_token);
    return googleTokens.access_token;
  } catch(e) {
    lastGoogleAuthError = e.message;
    console.error('Token refresh failed:', e);
    return null;
  }
}

// Auth status check
app.get('/auth/status', async (req, res) => {
  const status=await getGoogleConnectionStatus(GOOGLE_SCOPES);
  res.json({
    connected: status.connected,
    hasRefreshToken: status.hasRefreshToken,
    scopes: status.scopes,
    missingScopes: status.missingScopes,
    tokenExpiresAt: status.tokenExpiresAt,
    needsAuth: !status.connected,
    error: status.error || null
  });
});

// ════════════════════════════════════════════════════════
// GOOGLE CALENDAR
// ════════════════════════════════════════════════════════

app.get('/api/google/calendar', async (req, res) => {
  try {
    const now = new Date();
    const weekEnd = new Date(); weekEnd.setDate(weekEnd.getDate()+7);
    const events = await fetchGoogleCalendarEvents(now,weekEnd,50);
    res.json({calendarEvents: events});
  } catch(e) {
    res.json({calendarEvents:[], needsAuth: /google auth/i.test(e.message), authUrl:'/auth/google', error: e.message});
  }
});

app.get('/auth/microsoft',(req,res)=>{
  if(!MICROSOFT_CLIENT_ID||!MICROSOFT_REDIRECT_URI) return res.status(500).send('Microsoft OAuth is not configured.');
  const url='https://login.microsoftonline.com/common/oauth2/v2.0/authorize?'+new URLSearchParams({
    client_id:MICROSOFT_CLIENT_ID,
    response_type:'code',
    redirect_uri:MICROSOFT_REDIRECT_URI,
    response_mode:'query',
    scope:MICROSOFT_SCOPES.join(' '),
    prompt:'select_account'
  }).toString();
  res.redirect(url);
});
app.get('/auth/microsoft/callback',async(req,res)=>{
  const code=String(req.query.code||'');
  if(!code) return res.status(400).send('No Microsoft code received');
  try{
    const r=await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token',{
      method:'POST',
      headers:{'Content-Type':'application/x-www-form-urlencoded'},
      body:new URLSearchParams({
        client_id:MICROSOFT_CLIENT_ID,
        client_secret:MICROSOFT_CLIENT_SECRET,
        code,
        redirect_uri:MICROSOFT_REDIRECT_URI,
        grant_type:'authorization_code'
      })
    });
    const tokens=await readJsonResponse(r);
    if(!r.ok||tokens.error) throw new Error(tokens.error_description||tokens.error||`Microsoft token exchange failed (${r.status})`);
    await saveOAuthTokens('microsoft',{...tokens,issued_at:Date.now(),scope:tokens.scope||MICROSOFT_SCOPES.join(' ')});
    res.send('<h2 style="font-family:sans-serif;padding:2rem">Microsoft Outlook connected to VAL. You can close this tab.</h2>');
  }catch(e){
    res.status(500).send('Microsoft auth failed: '+e.message);
  }
});

async function getMicrosoftToken(){
  const saved=await loadOAuthTokens('microsoft');
  if(!saved)return null;
  const expiresAt=(Number(saved.issued_at)||0)+(Number(saved.expires_in)||3600)*1000-60000;
  if(saved.access_token&&Date.now()<expiresAt)return saved.access_token;
  if(!saved.refresh_token)return saved.access_token||null;
  const r=await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token',{
    method:'POST',
    headers:{'Content-Type':'application/x-www-form-urlencoded'},
    body:new URLSearchParams({
      client_id:MICROSOFT_CLIENT_ID,
      client_secret:MICROSOFT_CLIENT_SECRET,
      refresh_token:saved.refresh_token,
      grant_type:'refresh_token',
      scope:MICROSOFT_SCOPES.join(' ')
    })
  });
  const fresh=await readJsonResponse(r);
  if(!r.ok||fresh.error){
    console.error('Microsoft token refresh failed:',fresh.error_description||fresh.error||r.status);
    return saved.access_token||null;
  }
  const next={...saved,...fresh,refresh_token:fresh.refresh_token||saved.refresh_token,issued_at:Date.now()};
  await saveOAuthTokens('microsoft',next);
  return next.access_token;
}

async function fetchOutlookCalendarEvents(start,end,maxResults=75){
  const token=await getMicrosoftToken();
  if(!token) throw new Error('Microsoft auth required');
  const filter=`start/dateTime ge '${start.toISOString()}' and start/dateTime le '${end.toISOString()}'`;
  const url='https://graph.microsoft.com/v1.0/me/events?'+new URLSearchParams({
    '$top':String(maxResults),
    '$orderby':'start/dateTime',
    '$select':'id,subject,bodyPreview,start,end,location,attendees,organizer,webLink,isCancelled,onlineMeeting,onlineMeetingUrl',
    '$filter':filter
  }).toString();
  const r=await fetch(url,{headers:{Authorization:`Bearer ${token}`,Prefer:`outlook.timezone="${CLIENT_CONFIG.timezone}"`}});
  const d=await readJsonResponse(r);
  if(!r.ok) throw new Error(d.error?.message||`Microsoft calendar ${r.status}`);
  return (d.value||[]).map(e=>({
    id:e.id,
    summary:e.subject||'(No title)',
    title:e.subject||'(No title)',
    startTime:e.start?.dateTime,
    endTime:e.end?.dateTime,
    location:e.location?.displayName||'',
    description:e.bodyPreview||'',
    attendees:(e.attendees||[]).map(a=>({name:a.emailAddress?.name||'',email:String(a.emailAddress?.address||'').toLowerCase(),responseStatus:a.status?.response||''})),
    organizer:e.organizer?.emailAddress?{name:e.organizer.emailAddress.name||'',email:String(e.organizer.emailAddress.address||'').toLowerCase()}:{},
    status:e.isCancelled?'cancelled':'confirmed',
    source:'outlook',
    calendarName:'Outlook Calendar',
    webLink:e.webLink||'',
    meetingLink:e.onlineMeeting?.joinUrl||e.onlineMeetingUrl||e.webLink||'',
    raw:e
  }));
}

async function fetchGoogleCalendarEvents(start,end,maxResults=50){
  const token = await getGoogleToken();
  if(!token) throw new Error('Google auth required');
  const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${start.toISOString()}&timeMax=${end.toISOString()}&singleEvents=true&orderBy=startTime&maxResults=${maxResults}`;
  const r = await fetch(url, {headers:{Authorization:`Bearer ${token}`}});
  const d = await r.json();
  if(d.error) throw new Error(d.error.message || 'Google calendar error');
  return (d.items||[]).map(e=>({
    id: e.id,
    summary: e.summary||'(No title)',
    title: e.summary||'(No title)',
    startTime: e.start?.dateTime||e.start?.date,
    endTime: e.end?.dateTime||e.end?.date,
    location: e.location,
    description: e.description,
    attendees: (e.attendees||[]).map(a=>({name:a.displayName||'',email:a.email||'',responseStatus:a.responseStatus||''})),
    organizer:e.organizer?{name:e.organizer.displayName||'',email:e.organizer.email||''}:{},
    status: e.status,
    source: 'google',
    calendarName: 'Google Calendar',
    meetingLink:e.hangoutLink||(e.conferenceData?.entryPoints||[]).find(p=>p.entryPointType==='video')?.uri||'',
    raw:e
  }));
}

async function fetchGhlCalendarEvents(start,end){
  const accounts=await resolvedGhlAccounts();
  const seen = new Set();
  const events = [];
  for(const account of accounts){
    const calendarMap = new Map();
    let calendarIds = (account.calendarIds||[]).slice();
    if(!calendarIds.length){
      try{
        const data = await ghlForAccount(account,'GET',`/calendars/?locationId=${account.locationId}`);
        const calendars = data.calendars || [];
        calendars.forEach(c=>{ if(c.id){ calendarMap.set(String(c.id),c.name||c.title||`${account.label} Calendar`); calendarIds.push(String(c.id)); } });
      }catch(e){ console.error(`GHL calendar list error (${account.label}):`,e.message); }
    }
    calendarIds = Array.from(new Set(calendarIds));
    const range = `locationId=${encodeURIComponent(account.locationId)}&startTime=${start.getTime()}&endTime=${end.getTime()}`;
    const calls = calendarIds.length
      ? calendarIds.map(id=>ghlForAccount(account,'GET',`/calendars/events?${range}&calendarId=${encodeURIComponent(id)}`).then(d=>({id,data:d,account})))
      : [ghlForAccount(account,'GET',`/calendars/events?${range}`).then(d=>({id:'all',data:d,account}))];
    const results = await Promise.allSettled(calls);
    results.forEach(r=>{
      if(r.status!=='fulfilled') return;
      const calendarId = r.value.id;
      const list = r.value.data.events || r.value.data.appointments || [];
      list.forEach(ev=>{
        const key = `${account.slug}-${ev.id||ev.appointmentId||ev.startTime||ev.start}-${calendarId}`;
        if(seen.has(key)) return;
        seen.add(key);
        events.push({
          id: ev.id||ev.appointmentId,
          title: ev.title||ev.name||ev.summary,
          summary: ev.title||ev.name||ev.summary,
          contactName: ev.contactName||ev.contact?.name,
          startTime: ev.startTime||ev.start,
          endTime: ev.endTime||ev.end,
          status: ev.appointmentStatus||ev.status,
          source: 'ghl',
          accountSlug:account.slug,
          accountLabel:account.label,
          owner: inferValOwner(ev),
          calendarId,
          calendarName: calendarMap.get(String(calendarId)) || ev.calendarName || `${account.label} Calendar`
        });
      });
    });
  }
  return events;
}

// ════════════════════════════════════════════════════════
// GMAIL — replies from GHL contacts only
// ════════════════════════════════════════════════════════

app.get('/api/google/gmail', async (req, res) => {
  try {
    const token = await getGoogleToken();
    if(!token) return res.json({emails:[], needsAuth: true});

    // First get GHL contacts to cross-reference
    const contactsData = await ghl('GET', `/contacts/?locationId=${GHL_LOC}&limit=100&sortBy=date_added&sortDirection=desc`);
    const contacts = contactsData.contacts||[];
    const contactEmails = new Set(contacts.map(c=>c.email).filter(Boolean).map(e=>e.toLowerCase()));

    // Search Gmail for recent unread messages
    const searchUrl = `https://www.googleapis.com/gmail/v1/users/me/messages?q=is:unread newer_than:7d&maxResults=20`;
    const r = await fetch(searchUrl, {headers:{Authorization:`Bearer ${token}`}});
    const d = await r.json();
    const messages = d.messages||[];

    // Fetch each message header
    const emailDetails = await Promise.all(messages.slice(0,10).map(async m=>{
      const mr = await fetch(`https://www.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
        {headers:{Authorization:`Bearer ${token}`}});
      const md = await mr.json();
      const headers = md.payload?.headers||[];
      const from = headers.find(h=>h.name==='From')?.value||'';
      const subject = headers.find(h=>h.name==='Subject')?.value||'';
      const date = headers.find(h=>h.name==='Date')?.value||'';
      const emailMatch = from.match(/<(.+?)>/)||[null,from];
      const fromEmail = emailMatch[1]?.toLowerCase()||'';
      const fromName = from.replace(/<.*>/,'').trim().replace(/"/g,'');
      const isGHLContact = contactEmails.has(fromEmail);
      return {id:m.id, from, fromEmail, fromName, subject, date, isGHLContact};
    }));

    const ghlEmails = emailDetails.filter(e=>e.isGHLContact);
    res.json({emails: emailDetails, ghlEmails, total: messages.length});
  } catch(e) {
    res.json({emails:[], error: e.message});
  }
});

function parseEmailAddress(raw){
  const text=String(raw||'').trim();
  const match=text.match(/^(.*?)\s*<([^>]+)>$/);
  const email=(match?match[2]:text).replace(/"/g,'').trim().toLowerCase();
  const name=(match?match[1]:text.replace(email,'')).replace(/"/g,'').trim();
  return {name:name||email.split('@')[0]||'',email};
}
function decodeBase64Url(value){
  if(!value)return '';
  try{return Buffer.from(String(value).replace(/-/g,'+').replace(/_/g,'/'),'base64').toString('utf8');}
  catch(e){return '';}
}
function extractGmailBody(payload){
  if(!payload)return '';
  if(payload.body?.data)return decodeBase64Url(payload.body.data);
  const parts=payload.parts||[];
  const plain=parts.find(p=>p.mimeType==='text/plain')||parts.find(p=>p.body?.data);
  if(plain?.body?.data)return decodeBase64Url(plain.body.data);
  for(const part of parts){
    const nested=extractGmailBody(part);
    if(nested)return nested;
  }
  return '';
}
function normalizeGmailMessage(md){
  const headers=md.payload?.headers||[];
  const header=name=>headers.find(h=>String(h.name||'').toLowerCase()===name.toLowerCase())?.value||'';
  const from=parseEmailAddress(header('From'));
  const bodyText=extractGmailBody(md.payload)||md.snippet||'';
  const to=String(header('To')||'').split(',').map(parseEmailAddress).filter(v=>v.email);
  const cc=String(header('Cc')||'').split(',').map(parseEmailAddress).filter(v=>v.email);
  const attachments=JSON.stringify(md.payload||{}).includes('"filename"');
  const date=header('Date') ? new Date(header('Date')).toISOString() : '';
  return {
    provider:'gmail',
    messageId:md.id||'',
    threadId:md.threadId||'',
    subject:header('Subject')||'(No subject)',
    from,
    to,
    cc,
    date,
    receivedAt:date,
    snippet:md.snippet||'',
    bodyPreview:String(bodyText||'').slice(0,700),
    bodyText:String(bodyText||''),
    labels:md.labelIds||[],
    hasAttachments:attachments,
    webLink:`https://mail.google.com/mail/u/0/#inbox/${md.threadId||md.id}`,
    classification:'',
    recommendedAction:'',
    matchedContact:{},
    matchedRuleId:'',
    requiresApproval:true,
    confidence:'medium'
  };
}
function classifyEmail(email,rules=[]){
  const text=[email.subject,email.snippet,email.bodyPreview,email.bodyText,email.from?.email].join(' ').toLowerCase();
  const domain=(email.from?.email||'').split('@')[1]||'';
  const activeRules=rules.filter(r=>r.is_active!==false&&r.isActive!==false);
  for(const rule of activeRules){
    const conditions=rule.conditions||rule.conditions_json||rule.conditionsJson||{};
    if((conditions.from_email&&conditions.from_email===email.from?.email) || (conditions.from_domain&&conditions.from_domain===domain)){
      const type=rule.ruleType||rule.rule_type;
      const actions=rule.actions||rule.actions_json||rule.actionsJson||{};
      return {
        classification:type==='ignore_sender'||type==='ignore_domain'?'ignored':type==='forward_sender'||type==='forward_category'?'forward_to_team':type==='vip_priority'?'needs_attention':'needs_attention',
        reason:`Matched saved rule: ${rule.rule_name||rule.ruleName||type}`,
        recommendedAction:actions.action==='forward'?`Forward to ${actions.forward_to}`:actions.action||type,
        confidence:'high',
        matchedRuleId:rule.id,
        requiresApproval:(rule.approvalMode||rule.approval_mode)!=='always_auto'
      };
    }
  }
  if(/\b(unsubscribe|special offer|limited time|book a call|seo|cold email|quick question|sponsor|advertis|newsletter)\b/.test(text)){
    return {classification:'solicitation',reason:'Looks promotional or unsolicited.',recommendedAction:'Move to low priority review.',confidence:'medium',requiresApproval:true};
  }
  if(/\b(invoice|contract|agreement|legal|payment|billing|complaint|confidential|medical|hr|termination)\b/.test(text)){
    return {classification:'needs_attention',reason:'Sensitive or high-stakes language detected.',recommendedAction:'Review before any action.',confidence:'high',requiresApproval:true,sensitive:true};
  }
  if(/\b(can you|could you|please|confirm|question|let me know|reply|respond|available|schedule|meeting)\b/.test(text)){
    return {classification:'needs_reply',reason:'Asks for a response or decision.',recommendedAction:'Draft a reply for approval.',confidence:'high',requiresApproval:true};
  }
  if(/\b(proposal|pricing|contract|intro|introduction|following up|checking in)\b/.test(text)){
    return {classification:'waiting_on_response',reason:'Looks connected to a deal, intro, or follow-up loop.',recommendedAction:'Track response and draft follow-up if needed.',confidence:'medium',requiresApproval:true};
  }
  return {classification:'low_priority',reason:'No urgent request detected.',recommendedAction:'Keep in low priority unless this sender matters.',confidence:'medium',requiresApproval:true};
}
function emailNeedsResponseSignal(email){
  return /\b(proposal|contract|pricing|introduction|intro|please confirm|let me know|waiting on|can you review|next steps|following up|recap|circle back|review this|thoughts|approve|approval)\b/i.test([email.subject,email.snippet,email.bodyPreview,email.bodyText].join(' '));
}
function businessDaysSince(value){
  const start=new Date(value||0);
  if(isNaN(start.getTime())) return 0;
  let days=0;
  const cur=new Date(start);
  cur.setHours(0,0,0,0);
  const today=new Date();
  today.setHours(0,0,0,0);
  while(cur<today){
    cur.setDate(cur.getDate()+1);
    const day=cur.getDay();
    if(day!==0&&day!==6) days++;
  }
  return days;
}
function waitingOnResponseFromSent(sentEmails=[],allEmails=[],threshold=3){
  const seenThreads=new Set();
  const inboundThreads=new Set(allEmails.filter(e=>!String(e.labels||[]).includes('SENT')).map(e=>e.threadId).filter(Boolean));
  return sentEmails.filter(email=>{
    if(!email.threadId||seenThreads.has(email.threadId)) return false;
    seenThreads.add(email.threadId);
    if(inboundThreads.has(email.threadId)) return false;
    return emailNeedsResponseSignal(email)&&businessDaysSince(email.date||email.receivedAt)>=threshold;
  }).map(email=>({
    ...email,
    classification:'waiting_on_response',
    reason:'Sent email appears to need a response and no later reply was found in the fetched window.',
    recommendedAction:'Draft a concise follow-up or create a follow-up task.',
    confidence:businessDaysSince(email.date||email.receivedAt)>=5?'high':'medium',
    requiresApproval:true
  }));
}
function gmailMeetingContextShape(email,reason='Matched meeting attendee or keyword'){
  return {
    subject:email.subject||'',
    from:email.from?.email||email.from?.name||'',
    date:email.date||email.receivedAt||'',
    summary:email.bodyPreview||email.snippet||'',
    relevanceReason:reason
  };
}
async function listEmailRules(userId){
  await valDbReady;
  if(pgPool){
    const r=await dbQuery('select * from email_rules where tenant_id=$1 and (user_id=$2 or user_id is null) order by created_at desc',[tenantId(),userId]);
    return (r.rows||[]).map(row=>({
      id:row.id,userId:row.user_id,tenantId:row.tenant_id,provider:row.provider,ruleName:row.rule_name,ruleType:row.rule_type,
      conditions:row.conditions_json||{},actions:row.actions_json||{},approvalMode:row.approval_mode,confidenceThreshold:row.confidence_threshold,
      isActive:row.is_active,createdFrom:row.created_from,createdFromMessageId:row.created_from_message_id,createdFromThreadId:row.created_from_thread_id,
      createdAt:row.created_at,updatedAt:row.updated_at,lastUsedAt:row.last_used_at,usageCount:row.usage_count
    }));
  }
  return (valStore().emailRules||[]).filter(r=>r.tenantId===tenantId()&&(r.userId===userId||!r.userId));
}
async function saveEmailRule(userId,rule){
  const id=rule.id||uuid('erule');
  const now=new Date().toISOString();
  const record={
    id,userId,tenantId:tenantId(),provider:rule.provider||'any',ruleName:rule.ruleName||rule.rule_name||'Email rule',
    ruleType:rule.ruleType||rule.rule_type||'label',conditions:rule.conditions||rule.conditions_json||{},
    actions:rule.actions||rule.actions_json||{},approvalMode:rule.approvalMode||rule.approval_mode||'review_only',
    confidenceThreshold:rule.confidenceThreshold||rule.confidence_threshold||'medium',isActive:rule.isActive!==false,
    createdFrom:rule.createdFrom||rule.created_from||'user_confirmation',createdFromMessageId:rule.createdFromMessageId||rule.created_from_message_id||'',
    createdFromThreadId:rule.createdFromThreadId||rule.created_from_thread_id||'',createdAt:rule.createdAt||now,updatedAt:now,lastUsedAt:rule.lastUsedAt||null,usageCount:rule.usageCount||0
  };
  if(pgPool){
    const r=await dbQuery(`
      insert into email_rules (id,user_id,tenant_id,provider,rule_name,rule_type,conditions_json,actions_json,approval_mode,confidence_threshold,is_active,created_from,created_from_message_id,created_from_thread_id,created_at,updated_at)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,now(),now())
      on conflict (id) do update set rule_name=excluded.rule_name,conditions_json=excluded.conditions_json,actions_json=excluded.actions_json,approval_mode=excluded.approval_mode,confidence_threshold=excluded.confidence_threshold,is_active=excluded.is_active,updated_at=now()
      returning *
    `,[id,userId,tenantId(),record.provider,record.ruleName,record.ruleType,record.conditions,record.actions,record.approvalMode,record.confidenceThreshold,record.isActive,record.createdFrom,record.createdFromMessageId,record.createdFromThreadId]);
    return (await listEmailRules(userId)).find(x=>x.id===r.rows[0].id);
  }
  const store=valStore();
  store.emailRules=store.emailRules||[];
  const idx=store.emailRules.findIndex(r=>r.id===id);
  if(idx>=0)store.emailRules[idx]={...store.emailRules[idx],...record};
  else store.emailRules.push(record);
  saveValStore(store);
  return record;
}
async function logEmailAction(userId,entry){
  const record={id:uuid('elog'),userId,tenantId:tenantId(),provider:entry.provider||'',messageId:entry.messageId||'',threadId:entry.threadId||'',actionType:entry.actionType||entry.action_type||'classified',actionStatus:entry.actionStatus||entry.action_status||'suggested',actedBy:entry.actedBy||entry.acted_by||'val',ruleId:entry.ruleId||entry.rule_id||'',details:entry.details||entry.details_json||{},createdAt:new Date().toISOString()};
  if(pgPool){
    await dbQuery('insert into email_action_log (id,user_id,tenant_id,provider,message_id,thread_id,action_type,action_status,acted_by,rule_id,details_json) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[record.id,userId,tenantId(),record.provider,record.messageId,record.threadId,record.actionType,record.actionStatus,record.actedBy,record.ruleId,record.details]);
  }else{
    const store=valStore();store.emailActionLog=store.emailActionLog||[];store.emailActionLog.push(record);saveValStore(store);
  }
  return record;
}
async function recentEmailActions(userId,limit=200){
  if(pgPool){
    const r=await dbQuery('select * from email_action_log where tenant_id=$1 and user_id=$2 order by created_at desc limit $3',[tenantId(),userId,limit]);
    return r.rows||[];
  }
  return (valStore().emailActionLog||[]).filter(a=>a.tenantId===tenantId()&&a.userId===userId).slice(-limit).reverse();
}
async function fetchGmailMessages({userId=currentUserId(),tenantId:tenantIdValue=tenantId(),query='newer_than:7d',maxResults=25,includeBody=false}={}){
  await ensureGoogleTokensLoaded();
  const token=await getGoogleToken();
  if(token) await hydrateGoogleTokenScopes(token);
  const missing=missingGoogleScopes(['https://www.googleapis.com/auth/gmail.readonly']);
  if(missing.length) return {emails:[],needsAuth:true,missingScopes:missing,error:'Reconnect Google to grant Gmail read permission.',provider:'gmail',userId,tenantId:tenantIdValue};
  if(!token)return {emails:[],needsAuth:true,missingScopes:missingGoogleScopes(['https://www.googleapis.com/auth/gmail.readonly']),error:lastGoogleAuthError||'Google auth required',provider:'gmail',userId,tenantId:tenantIdValue};
  const limit=Math.min(Number(maxResults)||20,100);
  const searchUrl=`https://www.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=${encodeURIComponent(limit)}`;
  const r=await fetch(searchUrl,{headers:{Authorization:`Bearer ${token}`}});
  const d=await readJsonResponse(r);
  if(!r.ok) return {emails:[],needsAuth:r.status===401,error:d.error?.message||`Gmail ${r.status}`,provider:'gmail',missingScopes:missingGoogleScopes(['https://www.googleapis.com/auth/gmail.readonly']),userId,tenantId:tenantIdValue};
  const messages=d.messages||[];
  const details=await mapWithConcurrency(messages.slice(0,limit),5,async m=>{
    const format=includeBody?'full':'full';
    const mr=await fetch(`https://www.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=${format}`,{headers:{Authorization:`Bearer ${token}`}});
    const md=await readJsonResponse(mr);
    if(!mr.ok) return null;
    return normalizeGmailMessage(md);
  });
  return {emails:details.filter(Boolean),needsAuth:false,provider:'gmail',missingScopes:missingGoogleScopes(['https://www.googleapis.com/auth/gmail.readonly']),query,userId,tenantId:tenantIdValue};
}
async function fetchUnifiedGmailEmails(limit=20){
  return fetchGmailMessages({query:'newer_than:14d',maxResults:limit});
}
function normalizeOutlookMessage(m){
  const from=m.from?.emailAddress||{};
  const to=(m.toRecipients||[]).map(r=>({name:r.emailAddress?.name||'',email:String(r.emailAddress?.address||'').toLowerCase()})).filter(v=>v.email);
  const cc=(m.ccRecipients||[]).map(r=>({name:r.emailAddress?.name||'',email:String(r.emailAddress?.address||'').toLowerCase()})).filter(v=>v.email);
  const bodyText=String(m.bodyPreview||m.body?.content||'').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
  return {
    provider:'outlook',
    messageId:m.id||'',
    threadId:m.conversationId||m.id||'',
    subject:m.subject||'(No subject)',
    from:{name:from.name||'',email:String(from.address||'').toLowerCase()},
    to,cc,
    receivedAt:m.receivedDateTime||m.sentDateTime||'',
    snippet:m.bodyPreview||'',
    bodyPreview:bodyText.slice(0,700),
    bodyText,
    hasAttachments:!!m.hasAttachments,
    webLink:m.webLink||'',
    classification:'',
    recommendedAction:'',
    matchedContact:{},
    matchedRuleId:'',
    requiresApproval:true,
    confidence:'medium'
  };
}
async function fetchUnifiedOutlookEmails(limit=20){
  const token=await getMicrosoftToken();
  if(!token)return {emails:[],needsAuth:true,provider:'outlook'};
  const url=`https://graph.microsoft.com/v1.0/me/messages?$top=${encodeURIComponent(limit)}&$orderby=receivedDateTime desc&$select=id,conversationId,subject,from,toRecipients,ccRecipients,receivedDateTime,sentDateTime,bodyPreview,body,hasAttachments,webLink,isRead`;
  const r=await fetch(url,{headers:{Authorization:`Bearer ${token}`}});
  const d=await readJsonResponse(r);
  if(!r.ok)return {emails:[],needsAuth:r.status===401,error:d.error?.message||`Microsoft Graph ${r.status}`,provider:'outlook'};
  return {emails:(d.value||[]).map(normalizeOutlookMessage),needsAuth:false,provider:'outlook'};
}

function normalizeAttendee(attendee){
  if(!attendee) return null;
  if(typeof attendee === 'string'){
    const emailMatch = attendee.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    const email = emailMatch ? emailMatch[0].toLowerCase() : '';
    const name = attendee.replace(/<.*?>/g,'').replace(email,'').trim();
    if(!email && !name) return null;
    return {name:name || email.split('@')[0] || '', email};
  }
  const email = String(attendee.email || attendee.contactEmail || '').trim().toLowerCase();
  const name = String(attendee.displayName || attendee.name || attendee.contactName || '').trim();
  if(!email && !name) return null;
  return {name:name || (email ? email.split('@')[0] : ''), email};
}

function inferAttendeesFromEvent(event){
  const seen = new Set();
  const people = [];
  const push = (item)=>{
    const attendee = normalizeAttendee(item);
    if(!attendee) return;
    if(attendee.email && OWNER_EMAILS.has(attendee.email)) return;
    const key = (attendee.email || attendee.name).toLowerCase();
    if(!key || seen.has(key)) return;
    seen.add(key);
    people.push(attendee);
  };
  (Array.isArray(event.attendees) ? event.attendees : []).forEach(push);
  if(event.organizer) push(event.organizer);
  if(event.creator) push(event.creator);
  if(event.contact || event.contactName) push({name:event.contact || event.contactName, email:event.contactEmail || ''});
  const text = [event.title,event.summary,event.description,event.desc,event.notes].filter(Boolean).join(' ');
  (text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig)||[]).forEach(email=>push({email}));
  if(!people.length){
    const title = String(event.title || event.summary || '').replace(/\b(call|meeting|sync|strategy|consult|session|with)\b/ig,' ');
    title.split(/\s[-|/:]\s|\swith\s/i).map(s=>s.trim()).filter(s=>/^[A-Z][a-z]+(\s+[A-Z][a-z]+)+$/.test(s)).forEach(name=>push({name}));
  }
  return people.slice(0,8);
}
function gmailMeetingQuery(event){
  const attendees=inferAttendeesFromEvent(event);
  const emails=attendees.map(a=>a.email).filter(Boolean).slice(0,8);
  const names=attendees.map(a=>a.name).filter(Boolean).slice(0,6);
  const titleWords=String(event.title||event.summary||'').split(/\s+/).filter(w=>w.length>3&&!/meeting|call|zoom|google|with/i.test(w)).slice(0,6);
  const parts=[
    ...emails.map(e=>`from:${e} OR to:${e}`),
    ...names.map(n=>`"${n.replace(/"/g,'')}"`),
    ...titleWords.map(w=>`"${w.replace(/"/g,'')}"`)
  ].filter(Boolean);
  return parts.length ? `newer_than:60d (${parts.join(' OR ')})` : 'newer_than:14d';
}
async function matchingTranscriptContext(event,limit=5){
  const linked=await linkedTranscriptsForEvent(event,limit).catch(()=>[]);
  if(linked.length>=limit) return linked.slice(0,limit);
  const transcripts=await recentTranscripts(90);
  const linkedIds=new Set(linked.map(t=>t.id));
  const fuzzy=transcripts.map(t=>({...t,match:scoreTranscriptMeetingMatch(t,event)}))
    .filter(t=>!linkedIds.has(t.id))
    .filter(t=>t.match.confidence>=0.2)
    .sort((a,b)=>b.match.confidence-a.match.confidence)
    .slice(0,Math.max(0,limit-linked.length))
    .map(t=>({id:t.id,title:t.title,type:t.type,createdAt:t.createdAt,confidence:t.match.confidence,reason:t.match.reason,summary:String(t.rawText||'').slice(0,900)}));
  return [...linked,...fuzzy].slice(0,limit);
}
async function matchingTaskContext(event,limit=10){
  const tasks=await loadTasks();
  const attendees=inferAttendeesFromEvent(event);
  const hay=[event.title,event.summary,...attendees.flatMap(a=>[a.name,a.email])].filter(Boolean).join(' ').toLowerCase();
  return tasks.filter(t=>{
    const text=[t.title,t.contactName,t.notes].join(' ').toLowerCase();
    return !t.completed && hay && text && (hay.includes(String(t.contactName||'').toLowerCase()) || attendees.some(a=>(a.email&&text.includes(a.email.toLowerCase()))||(a.name&&text.includes(a.name.toLowerCase()))) || text.includes(String(event.title||event.summary||'').toLowerCase().slice(0,40)));
  }).slice(0,limit);
}
function normalizeContextEmail(value){
  const email=String(value||'').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '';
}
function normalizeContextPhone(value){
  const digits=String(value||'').replace(/\D/g,'');
  if(digits.length<7) return '';
  return digits.length===11&&digits.startsWith('1') ? digits.slice(1) : digits;
}
function normalizeContextName(value){
  return String(value||'').toLowerCase().replace(/[^a-z0-9\s]/g,' ').replace(/\s+/g,' ').trim();
}
function collapseRepeatedName(value){
  const words=String(value||'').replace(/\s+/g,' ').trim().split(' ').filter(Boolean);
  if(words.length%2===0&&words.length>=4){
    const half=words.length/2;
    if(words.slice(0,half).join(' ').toLowerCase()===words.slice(half).join(' ').toLowerCase()) return words.slice(0,half).join(' ');
  }
  return words.join(' ');
}
function contextWords(value){
  return normalizeContextName(value).split(/\s+/).filter(w=>w.length>2&&!['meeting','call','with','from','the','and','for','val','google','zoom'].includes(w));
}
function looseNameScore(a,b){
  const aw=contextWords(a),bw=contextWords(b);
  if(!aw.length||!bw.length) return 0;
  const overlap=aw.filter(w=>bw.includes(w)).length;
  return overlap/Math.max(aw.length,bw.length);
}
function contactCandidateId(c){
  const email=normalizeContextEmail(c.email),phone=normalizeContextPhone(c.phone);
  return c.id||c.contactId||(email?'email:'+email:'')||(phone?'phone:'+phone:'')||('name:'+normalizeContextName(c.name||c.contactName));
}
function compactContactCandidate(c,source='unknown'){
  const base=c?.contact||c||{};
  const name=collapseRepeatedName(base.contactName||base.name||[base.firstName,base.lastName].filter(Boolean).join(' ')||base.companyName||base.email||base.phone||'');
  const email=normalizeContextEmail(base.email||base.contactEmail);
  const phone=normalizeContextPhone(base.phone||base.contactPhone);
  return {
    id:String(base.id||base.contactId||contactCandidateId({name,email,phone})),
    contactId:String(base.id||base.contactId||''),
    name,email,phone,
    company:base.companyName||base.company||base.businessName||base.organizationName||'',
    tags:base.tags||base.tag||[],
    source,
    raw:base
  };
}
function itemMentionsContact(item,contact){
  if(!item||!contact) return false;
  const hay=[item.title,item.summary,item.rawText,item.raw_text,item.notes,item.bodyPreview,item.snippet,item.body,JSON.stringify(item.metadata||{}),JSON.stringify(item.raw||{})].filter(Boolean).join(' ').toLowerCase();
  const needles=[contact.id,contact.contactId,contact.name,contact.email,contact.phone,contact.company].filter(Boolean).map(v=>String(v).toLowerCase());
  return needles.some(n=>n&&hay.includes(n));
}
function extractOpenLoopsFromText(text,source='memory',sourceDate='',contact={}){
  const raw=String(text||'').replace(/\s+/g,' ').trim();
  if(!raw) return [];
  const markers=/\b(follow up|send|share|review|schedule|introduce|intro|connect|draft|prepare|update|check|circle back|waiting on|owed|promised|needs to|need to|will|should)\b/i;
  return raw.split(/(?<=[.!?])\s+|\n+/).map(s=>s.trim()).filter(sentence=>{
    return sentence.length>=18&&sentence.length<=320&&markers.test(sentence)&&!/\b(done|completed|sent already|already sent|handled|closed out|resolved)\b/i.test(sentence);
  }).slice(0,8).map(sentence=>({
    text:sentence,source,sourceDate:sourceDate||'',
    contactId:contact.contactId||contact.id||'',contactName:contact.name||contact.contactName||'',
    confidence:/\b(promised|owed|waiting on|follow up|send|schedule|introduce)\b/i.test(sentence)?'high':'medium'
  }));
}
async function collectContextContactCandidates(input={}){
  const candidates=[];
  const queries=new Set();
  const addQuery=v=>String(v||'').trim().length>=3&&queries.add(String(v).trim());
  [input.name,input.email,input.phone,input.company].forEach(addQuery);
  inferAttendeesFromEvent(input.calendarEvent||{attendees:input.attendees||[]}).forEach(a=>{addQuery(a.email);addQuery(a.name);});
  splitPeopleFromText([input.transcript,input.emailThread,JSON.stringify(input.calendarEvent||{})].join(' ')).forEach(p=>{addQuery(p.email);addQuery(p.name);});
  const addCandidate=(c,source)=>{
    const compact=compactContactCandidate(c,source);
    if(compact.id&&!candidates.some(x=>x.id===compact.id)) candidates.push(compact);
  };
  try{
    const ghlKey=await resolveIntegrationSecret('ghl','api_key',GHL_KEY);
    const ghlLoc=await resolveGhlLocationId();
    if(ghlKey&&ghlLoc){
      for(const q of Array.from(queries).slice(0,8)){
        const d=await ghl('GET',`/contacts/?locationId=${encodeURIComponent(ghlLoc)}&query=${encodeURIComponent(q)}&limit=5`).catch(()=>({contacts:[]}));
        (d.contacts||[]).forEach(c=>addCandidate(c,'ghl_contact'));
      }
    }
  }catch(e){}
  (await loadTasks().catch(()=>[])).filter(t=>t.contactName).slice(0,120).forEach(t=>addCandidate({name:t.contactName,id:'task-contact:'+normalizeContextName(t.contactName)},'task'));
  (await recentTranscripts(180).catch(()=>[])).slice(0,120).forEach(t=>{
    const meta=t.metadata||{};
    [meta.contactName,meta.name,meta.email,meta.contactEmail].filter(Boolean).forEach(v=>addCandidate({name:String(v).includes('@')?'':v,email:String(v).includes('@')?v:''},'transcript_metadata'));
    splitPeopleFromText([t.title,String(t.rawText||'').slice(0,1000)].join(' ')).slice(0,4).forEach(p=>addCandidate(p,'transcript'));
  });
  (await recentMemoryItems(180,180).catch(()=>[])).forEach(m=>{
    const meta=m.metadata||{};
    [meta.contactName,meta.name,meta.email,meta.contactEmail].filter(Boolean).forEach(v=>addCandidate({name:String(v).includes('@')?'':v,email:String(v).includes('@')?v:''},'memory_metadata'));
  });
  return candidates.slice(0,80);
}
async function resolveContactFromContext(input={}){
  const target={name:input.name||input.contactName||'',email:normalizeContextEmail(input.email||input.contactEmail),phone:normalizeContextPhone(input.phone||input.contactPhone),company:input.company||input.companyName||''};
  const attendees=inferAttendeesFromEvent(input.calendarEvent||{attendees:input.attendees||[]});
  if(!target.email&&attendees.find(a=>a.email)) target.email=attendees.find(a=>a.email).email;
  if(!target.name&&attendees.find(a=>a.name)) target.name=attendees.find(a=>a.name).name;
  const candidates=await collectContextContactCandidates({...input,...target});
  const scored=candidates.map(c=>{
    let score=0,reasons=[];
    if(target.email&&c.email===target.email){score+=0.75;reasons.push('exact email');}
    if(target.phone&&c.phone&&c.phone===target.phone){score+=0.7;reasons.push('exact phone');}
    const ns=looseNameScore(target.name,c.name);
    if(ns>=0.5){score+=0.35*ns;reasons.push('name match');}
    const cs=looseNameScore(target.company,c.company);
    if(cs>=0.5){score+=0.18*cs;reasons.push('company match');}
    if(attendees.some(a=>(a.email&&a.email===c.email)||(a.name&&looseNameScore(a.name,c.name)>=0.65))){score+=0.25;reasons.push('calendar attendee');}
    if([input.transcript,input.emailThread].some(text=>itemMentionsContact({rawText:text},c))){score+=0.2;reasons.push('mentioned in supplied context');}
    return {...c,confidence:Math.min(1,Number(score.toFixed(2))),matchReasons:[...new Set(reasons)]};
  }).filter(c=>c.confidence>0).sort((a,b)=>b.confidence-a.confidence);
  const best=scored[0]||null;
  return {ok:true,status:best?(best.confidence>=0.75?'matched':'possible_match'):'not_found',confidence:best?.confidence||0,contact:best,matches:scored.slice(0,8),sourcesChecked:['GHL contacts','tasks','transcripts','memory','calendar attendees'],reason:best?best.matchReasons.join(', '):'No contact matched by email, phone, name, company, attendees, transcripts, tasks, or memory.'};
}
async function loadContextCalendarEvents(start,end){
  const events=[],errors=[];
  for(const [label,fn] of [['google',()=>fetchGoogleCalendarEvents(start,end,150)],['outlook',()=>fetchOutlookCalendarEvents(start,end,150)],['val',()=>fetchValCalendarEvents(start,end)],['ghl',()=>fetchGhlCalendarEvents(start,end)]]){
    try{events.push(...await fn());}catch(e){errors.push(`${label}: ${e.message}`);}
  }
  return {events,errors};
}
async function resolveMeetingContext(input={}){
  const start=input.date?new Date(input.date):new Date(Date.now()-7*24*60*60*1000);
  const end=input.date?new Date(input.date):new Date(Date.now()+14*24*60*60*1000);
  if(input.date){start.setHours(0,0,0,0);end.setHours(23,59,59,999);}
  const {events,errors}=await loadContextCalendarEvents(start,end);
  const id=String(input.calendarEventId||input.eventId||input.id||'');
  let meeting=events.find(e=>id&&(String(e.id)===id||String(e.eventId)===id))||null;
  if(!meeting&&input.title){
    const title=normalizeContextName(input.title);
    meeting=events.map(e=>({...e,_score:looseNameScore(title,e.title||e.summary)})).filter(e=>e._score>=0.35).sort((a,b)=>b._score-a._score)[0]||null;
  }
  if(!meeting) meeting={id:id||'',title:input.title||input.summary||'',summary:input.title||input.summary||'',source:input.source||'unknown',startTime:input.date||input.startTime||input.start||'',attendees:input.attendees||[]};
  const attendees=inferAttendeesFromEvent({...meeting,attendees:input.attendees||meeting.attendees||[]});
  const contactResolution=await resolveContactFromContext({name:input.name,email:input.email,company:input.company,calendarEvent:{...meeting,attendees},transcript:input.transcript||''});
  const [transcripts,tasks,memory,gmail,outlook,ghlContext]=await Promise.all([
    matchingTranscriptContext(meeting,8).catch(()=>[]),
    matchingTaskContext({...meeting,attendees},15).catch(()=>[]),
    recentMemoryItems(180,220).catch(()=>[]),
    fetchGmailMessages({query:gmailMeetingQuery({...meeting,attendees}),maxResults:12}).catch(e=>({emails:[],error:e.message})),
    fetchUnifiedOutlookEmails(12).catch(e=>({emails:[],error:e.message})),
    ghlPlatformContext([meeting.title,meeting.summary,...attendees.flatMap(a=>[a.name,a.email])].filter(Boolean).join(' '),{appointments:[meeting],contacts:[contactResolution.contact].filter(Boolean)},{limit:6,opportunityLimit:12,taskLimit:8}).catch(()=>'')
  ]);
  const contact=contactResolution.contact||{};
  const relatedMemory=memory.filter(m=>itemMentionsContact(m,contact)||itemMentionsContact(m,meeting)).slice(0,12);
  const emailContext=(gmail.emails||[]).concat(outlook.emails||[]).filter(e=>itemMentionsContact(e,contact)||attendees.some(a=>(a.email&&[e.from?.email,...(e.to||[]).map(t=>t.email),...(e.cc||[]).map(t=>t.email)].includes(a.email)))).slice(0,12);
  const openLoops=[
    ...tasks.filter(t=>!t.completed).map(t=>({text:t.title,source:'task',sourceDate:t.createdAt||t.dueDate||'',contactName:t.contactName||contact.name||'',confidence:'high'})),
    ...transcripts.flatMap(t=>extractOpenLoopsFromText(t.summary||t.rawText||'',`transcript:${t.id}`,t.createdAt,contact)),
    ...relatedMemory.flatMap(m=>extractOpenLoopsFromText(m.rawText||m.summary,`memory:${m.id}`,m.createdAt,contact)),
    ...ghlContext.split('\n').flatMap(line=>extractOpenLoopsFromText(line,'ghl_platform','',contact))
  ].slice(0,16);
  const sourcesChecked=[`Calendar events (${events.length})`,`Attendees (${attendees.length})`,`Linked/fuzzy transcripts (${transcripts.length})`,`Tasks (${tasks.length})`,`Memory items (${relatedMemory.length})`,`Gmail messages (${gmail.emails?.length||0})`,`Outlook messages (${outlook.emails?.length||0})`,`GHL platform context (${ghlContext?ghlContext.split('\n').filter(Boolean).length:0})`];
  return {ok:true,meeting:{...meeting,attendees},contactResolution,relationshipContext:{contact,attendees,relatedMemory,emailContext,ghlNotes:ghlContext,ghlContext},transcripts,tasks,openLoops,sourcesChecked,errors};
}
async function buildContactTimeline(contactInput,limit=80){
  const contact=typeof contactInput==='object'?contactInput:(await resolveContactFromContext({name:contactInput,email:contactInput})).contact;
  if(!contact) return {ok:false,error:'Contact not found',items:[]};
  const items=[];
  const add=(type,date,title,summary,sourceId='',raw={})=>items.push({type,date:date||'',title:title||type,summary:String(summary||'').slice(0,1200),sourceId,raw});
  const [tasks,transcripts,memory,drafts]=await Promise.all([loadTasks().catch(()=>[]),recentTranscripts(365).catch(()=>[]),recentMemoryItems(365,500).catch(()=>[]),listDrafts().catch(()=>[])]);
  tasks.filter(t=>itemMentionsContact(t,contact)).forEach(t=>add('task',t.createdAt||t.dueDate,t.title,t.notes,t.id,t));
  transcripts.filter(t=>itemMentionsContact(t,contact)).forEach(t=>add('transcript',t.createdAt,t.title||'Transcript',t.rawText,t.id,t));
  memory.filter(m=>itemMentionsContact(m,contact)).forEach(m=>add(m.kind||'memory',m.createdAt,m.summary||m.kind,m.rawText,m.id,m));
  drafts.filter(d=>itemMentionsContact(d,contact)||String(d.contactId||'')===String(contact.contactId||contact.id||'')).forEach(d=>add('draft',d.createdAt,d.subject||d.draftType,d.body,d.id,d));
  try{if(contact.contactId)(await fetchContactNotes(contact.contactId,50)).forEach((n,i)=>add('ghl_note','',`GHL note ${i+1}`,n,contact.contactId,{note:n}));}catch(e){}
  try{
    const terms=[contact.email,contact.name,contact.company].filter(Boolean);
    for(const term of terms.slice(0,3)){
      const query=term.includes('@')?`from:${term} OR to:${term} newer_than:90d`:`"${String(term).replace(/"/g,'')}" newer_than:90d`;
      const gmail=await fetchGmailMessages({query,maxResults:10,includeBody:true});
      (gmail.emails||[]).forEach(e=>add('gmail',e.date||e.receivedAt,e.subject,gmailMeetingContextShape(e,'Matched contact timeline search').summary,e.messageId,e));
    }
  }catch(e){}
  const now=new Date(),past=new Date(now);past.setDate(past.getDate()-365);const future=new Date(now);future.setDate(future.getDate()+30);
  const {events}=await loadContextCalendarEvents(past,future);
  events.filter(e=>itemMentionsContact({title:e.title||e.summary,metadata:e,rawText:JSON.stringify(inferAttendeesFromEvent(e))},contact)).forEach(e=>add('meeting',e.startTime,e.title||e.summary,'Calendar event',e.id,e));
  const timeline=items.sort((a,b)=>new Date(b.date||0)-new Date(a.date||0)).slice(0,limit);
  const openLoops=timeline.flatMap(i=>extractOpenLoopsFromText(`${i.title}. ${i.summary}`,i.type,i.date,contact)).slice(0,12);
  return {ok:true,contact,timeline,openLoops,sourcesChecked:['tasks','transcripts','memory','drafts','GHL notes','calendar events']};
}
function personKey(name,email){
  const e=String(email||'').trim().toLowerCase();
  if(e) return 'email:'+e;
  return 'name:'+String(name||'Unknown').trim().toLowerCase().replace(/\s+/g,' ');
}
function cleanPersonName(value,email=''){
  const text=String(value||'').replace(/<.*?>/g,'').replace(/["']/g,'').trim();
  if(text&&text.includes('@')) return email ? email.split('@')[0] : text.split('@')[0];
  return collapseRepeatedName(text) || (email ? email.split('@')[0] : 'Unknown');
}
function relationshipEvidence(type,summary,date='',confidence='medium',sourceId=''){
  return {type,summary:String(summary||'').slice(0,260),date:date||'',confidence,sourceId};
}
function interactionDate(value){
  const d=new Date(value||0);
  return isNaN(d.getTime()) ? 0 : d.getTime();
}
function daysSince(value){
  const t=interactionDate(value);
  if(!t) return null;
  return Math.floor((Date.now()-t)/(24*60*60*1000));
}
function splitPeopleFromText(text){
  const raw=String(text||'');
  const emails=(raw.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig)||[]).slice(0,8).map(email=>({name:'',email:email.toLowerCase(),confidence:'high'}));
  const names=[...raw.matchAll(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})\b/g)].map(m=>m[1])
    .map(collapseRepeatedName)
    .filter(v=>!/Google Calendar|Zoom Meeting|VAL|GHL|CRM|Make|OpenAI|Railway|Postgres|United States|New Lead|Relationship Review|Executive Review/.test(v))
    .slice(0,8).map(name=>({name,email:'',confidence:'low'}));
  const seen=new Set();
  return emails.concat(names).filter(p=>{const k=personKey(p.name,p.email);if(seen.has(k))return false;seen.add(k);return true;});
}
async function recentMemoryItems(days=30,limit=120){
  if(DEMO_MODE){
    const state=requestContext.getStore()?.demoState || {};
    const transcriptItems=(state.transcripts||[]).map(t=>({id:t.id,kind:t.type||'transcript',summary:t.title||'Transcript',rawText:t.rawText||'',metadata:t.metadata||{},createdAt:t.createdAt||''}));
    const memoryItems=state.memoryItems||[];
    return cloneDemo(memoryItems.concat(transcriptItems).slice(0,limit));
  }
  await valDbReady;
  const since=new Date(Date.now()-Number(days)*24*60*60*1000).toISOString();
  if(pgPool){
    const r=await dbQuery('select id,kind,summary,raw_text,metadata,created_at from val_memory_items where user_id=$1 and created_at >= $2 order by created_at desc limit $3',[VAL_USER_ID,since,limit]);
    return r.rows.map(row=>({id:row.id,kind:row.kind,summary:row.summary||'',rawText:row.raw_text||'',metadata:row.metadata||{},createdAt:row.created_at?row.created_at.toISOString():''}));
  }
  return (valStore().memoryItems||[]).filter(m=>new Date(m.createdAt||0)>=new Date(since)).slice(0,limit);
}
async function condenseOlderMemory(){
  await valDbReady;
  const cutoff=new Date(Date.now()-30*24*60*60*1000),items=[];
  if(DEMO_MODE)return {ok:true,created:0,keptOriginals:true,demo:true};
  if(pgPool){
    const r=await dbQuery("select id,kind,summary,raw_text,metadata,created_at from val_memory_items where user_id=$1 and created_at < $2 and kind <> 'memory_condensation' order by created_at asc limit 500",[VAL_USER_ID,cutoff.toISOString()]);
    items.push(...r.rows.map(x=>({id:x.id,kind:x.kind,summary:x.summary||'',rawText:x.raw_text||'',metadata:x.metadata||{},createdAt:x.created_at?.toISOString()||''})));
  }else items.push(...(valStore().memoryItems||[]).filter(x=>new Date(x.createdAt||0)<cutoff&&x.kind!=='memory_condensation').slice(0,500));
  if(!items.length)return {ok:true,created:0,keptOriginals:true};
  const groups={};items.forEach(item=>{const d=new Date(item.createdAt||0),key=isNaN(d)?'undated':d.toISOString().slice(0,7);(groups[key]=groups[key]||[]).push(item);});
  let created=0;
  for(const [month,rows] of Object.entries(groups)){
    const sourceIds=rows.map(x=>x.id),fingerprint=crypto.createHash('sha256').update(sourceIds.join('|')).digest('hex').slice(0,20);
    const existing=await recentMemoryItems(3650,1000).catch(()=>[]);if(existing.some(x=>x.kind==='memory_condensation'&&x.metadata?.fingerprint===fingerprint))continue;
    const highlights=rows.sort((a,b)=>Number(b.importance||1)-Number(a.importance||1)).slice(0,40).map(x=>`[${x.kind}] ${x.summary||String(x.rawText||'').slice(0,240)}`).join('\n');
    await saveMemoryItem({kind:'memory_condensation',summary:`Condensed VAL memory for ${month} (${rows.length} original items retained)`,rawText:highlights,importance:4,metadata:{fingerprint,month,sourceIds,sourceCount:rows.length,keptOriginals:true,condensedAt:new Date().toISOString()}});created++;
  }
  return {ok:true,created,sourceItems:items.length,keptOriginals:true};
}
function relationshipScore(contact){
  const ev=contact.evidence||[];
  const hasPipeline=ev.some(e=>e.type==='opportunity');
  const hasMeeting=ev.some(e=>e.type==='meeting');
  const hasEmail=ev.some(e=>e.type==='email');
  const hasNote=ev.some(e=>e.type==='note');
  const hasTranscript=ev.some(e=>e.type==='transcript');
  const openLoops=(contact.openLoops||[]).length;
  const tags=(contact.tags||[]).map(t=>String(t).toLowerCase());
  const vip=contact.manualVip||tags.some(t=>/vip|client|partner|investor|mentor|referral|decision|prospect/.test(t));
  const strategic=Math.min(25,(vip?14:0)+(hasPipeline?8:0)+(contact.company?2:0)+(contact.superConnector?5:0)+(openLoops?3:0));
  const opportunity=Math.min(20,(hasPipeline?12:0)+(ev.some(e=>/proposal|pricing|contract|partnership|referral|intro|revenue|buying/i.test(e.summary))?6:0)+(contact.superConnector?3:0));
  const activity=Math.min(15,(hasMeeting?4:0)+(hasEmail?4:0)+(hasNote?3:0)+(hasTranscript?3:0)+Math.min(ev.length,5));
  const since=daysSince(contact.lastInteractionAt);
  const drift=Math.min(15,((since!==null&&since>=14)?7:0)+((since!==null&&since>=30)?4:0)+(openLoops?4:0)+(ev.some(e=>/stalled|overdue|pending|waiting/i.test(e.summary))?4:0));
  const loops=Math.min(15,openLoops*4+(ev.some(e=>/follow up|send|review|schedule|introduce|proposal|pending|waiting/i.test(e.summary))?5:0));
  const reciprocity=Math.min(10,(ev.some(e=>/referral|introduced|introduction|connected/i.test(e.summary))?5:0)+(contact.superConnector?5:0));
  return {
    total:Math.min(100,Math.round(strategic+opportunity+activity+drift+loops+reciprocity)),
    strategicImportance:strategic,opportunityPotential:opportunity,relationshipActivity:activity,driftRisk:drift,openLoopsCommitments:loops,reciprocityBalance:reciprocity
  };
}
function recommendedRelationshipAction(contact){
  if((contact.openLoops||[]).length) return `Close the open loop: ${contact.openLoops[0]}`;
  if(contact.lastInteractionDays!==null&&contact.lastInteractionDays>=14) return `Send a specific reconnect note referencing ${contact.lastEvidenceSummary||'the last known conversation'}.`;
  if(contact.superConnector) return 'Ask what they are seeing in the market and whether there is someone useful you can support or introduce.';
  if(contact.scoreBreakdown?.opportunityPotential>=10) return 'Move the opportunity forward with one concrete next step.';
  return 'Send a short, specific value-add check-in.';
}
function draftRelationshipOutreach(contact){
  const name=(contact.name||'there').split(/\s+/)[0];
  const evidence=contact.lastEvidenceSummary||'our last conversation';
  const ask=(contact.openLoops||[])[0]||contact.recommendedAction||'keep momentum moving';
  return {
    type:'email',
    subject:`Quick follow-up${contact.company?' re: '+contact.company:''}`,
    body:`Hi ${name},\n\nI was thinking about ${evidence}. I wanted to follow up while it is still fresh.\n\n${ask}\n\nWould it be useful to compare notes for a few minutes this week?`
  };
}
function relationshipProfile(contact){
  return {
    name:contact.name,company:contact.company||'',email:contact.email||'',score:contact.score,scoreBreakdown:contact.scoreBreakdown,
    relationshipType:contact.relationshipType||'Professional',relationshipSummary:contact.reason,recentTopics:contact.topics||[],openLoops:contact.openLoops||[],
    lastMeaningfulInteraction:contact.lastInteractionAt||'',strategicValue:contact.strategicValue||'Evidence-based relationship priority.',
    opportunitySignals:contact.opportunitySignals||[],riskSignals:contact.riskSignals||[],suggestedNextAction:contact.recommendedAction,
    suggestedOutreach:contact.draftOutreach,relatedContacts:contact.relatedContacts||[],tags:contact.tags||[],evidence:contact.evidence||[],evidenceCount:(contact.evidence||[]).length,contactId:contact.contactId||contact.id||''
  };
}
function relationshipOwnerIdentity(){
  const emails=[process.env.ADMIN_EMAIL,process.env.VAL_OWNER_EMAIL,process.env.GMAIL_USER_EMAIL,process.env.OUTLOOK_USER_EMAIL]
    .concat(String(process.env.VAL_OWNER_ALIASES||'').split(',')).map(normalizeContextEmail).filter(Boolean);
  const names=[process.env.ADMIN_NAME,process.env.VAL_CLIENT_NAME,CLIENT_CONFIG.clientName,process.env.VAL_OWNER_NAME]
    .concat(String(process.env.VAL_OWNER_ALIASES||'').split(',')).map(normalizeContextName).filter(Boolean);
  return {emails:new Set(emails),names:new Set(names)};
}
function isOwnerRelationship(candidate={},owner=relationshipOwnerIdentity()){
  const email=normalizeContextEmail(candidate.email||candidate.contactEmail||'');
  const name=normalizeContextName(candidate.name||candidate.contactName||'');
  if(email&&owner.emails.has(email)) return true;
  if(name&&owner.names.has(name)) return true;
  if(name&&[...owner.names].some(alias=>looseNameScore(name,alias)>=0.8)) return true;
  return candidate.self===true||candidate.organizer===true&&(!email||owner.emails.has(email));
}
function isMeaningfulRelationshipEmail(email={}){
  const from=`${email.from?.name||''} ${email.from?.email||''}`.toLowerCase();
  const subject=String(email.subject||'').toLowerCase();
  if(/mailsuite|mailtrack|email tracking|tracking notification/.test(from+' '+subject)) return false;
  if(/^(opened:|email opened|link clicked|your email was opened)/.test(subject)) return false;
  return true;
}
function relationshipEmailParticipants(email={}){
  const values=[email.from,...(email.to||[]),...(email.cc||[])].filter(Boolean);
  return values.map(v=>({name:v.name||v.displayName||'',email:v.email||v.address||''}));
}
function synthesizeRelationshipSummary(contact={}){
  const types=[...new Set((contact.evidence||[]).map(e=>e.type))];
  const context=contact.company?`${contact.name} is connected to ${contact.company}.`:`${contact.name} is an external relationship worth understanding.`;
  const recent=contact.lastEvidenceSummary?` Recent activity includes ${String(contact.lastEvidenceSummary).replace(/\s+/g,' ').slice(0,180)}.`:'';
  const why=(contact.opportunitySignals||[]).length?' There is a live opportunity, referral, or partnership signal.':(contact.openLoops||[]).length?' An open commitment makes timely follow-through important.':` Evidence comes from ${types.join(', ')||'connected activity'}.`;
  return `${context}${recent}${why} ${contact.recommendedAction||'Review the relationship and choose one useful next move.'}`.replace(/\s+/g,' ').trim();
}
async function buildRelationshipReview({windowDays=7}={}){
  const now=new Date();
  const past=new Date(now);past.setDate(past.getDate()-Math.max(Number(windowDays)||7,7));
  const widerPast=new Date(now);widerPast.setDate(widerPast.getDate()-45);
  const future=new Date(now);future.setDate(future.getDate()+14);
  const people=new Map();
  const errors=[];
  const owner=relationshipOwnerIdentity();
  function touch({name='',email='',company='',tags=[]}){
    const cleanName=cleanPersonName(name,email),cleanEmail=normalizeContextEmail(email);
    if(isOwnerRelationship({name:cleanName,email:cleanEmail},owner)||(!cleanEmail&&(!cleanName||cleanName==='Unknown'))) return null;
    if(/^(no.?reply|notifications?|mailer-daemon)@/i.test(cleanEmail)) return null;
    const normalizedName=normalizeContextName(cleanName),normalizedCompany=normalizeContextName(company);
    let p=[...new Set(people.values())].find(existing=>(cleanEmail&&existing.email===cleanEmail)||(normalizedName&&normalizeContextName(existing.name)===normalizedName)||(normalizedName&&normalizedCompany&&normalizeContextName(existing.company)===normalizedCompany&&looseNameScore(existing.name,cleanName)>=0.5));
    const key=personKey(cleanName,cleanEmail);
    if(!p){p={key,name:cleanName,email:cleanEmail,company:company||'',tags:[],evidence:[],openLoops:[],opportunitySignals:[],riskSignals:[],topics:[],relatedContacts:[]};}
    people.set(key,p);
    if(name&&(!p.name||p.name==='Unknown')) p.name=cleanPersonName(name,email);
    if(cleanEmail&&!p.email) p.email=cleanEmail;
    if(company&&!p.company) p.company=company;
    p.tags=Array.from(new Set((p.tags||[]).concat(tags||[]).filter(Boolean)));
    return p;
  }
  function addEvidence(person,evidence){
    if(!person||!evidence.summary)return;
    person.evidence.push(evidence);
    if(evidence.date&&interactionDate(evidence.date)>interactionDate(person.lastInteractionAt)) {
      person.lastInteractionAt=evidence.date;
      person.lastEvidenceSummary=evidence.summary;
    }
    if(/follow up|send|review|schedule|introduce|proposal|pending|waiting|owed|promised/i.test(evidence.summary)){
      person.openLoops=Array.from(new Set((person.openLoops||[]).concat(evidence.summary.slice(0,180)))).slice(0,8);
    }
    if(/proposal|pricing|contract|partnership|referral|intro|revenue|opportunity|pipeline/i.test(evidence.summary)) person.opportunitySignals.push(evidence.summary.slice(0,180));
    if(/stalled|overdue|waiting|no response|missed|forgotten|cooling/i.test(evidence.summary)) person.riskSignals.push(evidence.summary.slice(0,180));
    const topic=String(evidence.summary||'').split(/[.!?]/)[0].slice(0,90);
    if(topic) person.topics=Array.from(new Set((person.topics||[]).concat(topic))).slice(0,8);
  }
  const [gmail,outlook,tasks,transcripts,memory,preferenceMemory,ghlEvents,googleEvents,pipeline]=await Promise.all([
    fetchGmailMessages({query:'newer_than:45d',maxResults:60}).catch(e=>{errors.push('Gmail: '+e.message);return {emails:[],error:e.message};}),
    fetchUnifiedOutlookEmails(60).catch(e=>{errors.push('Outlook: '+e.message);return {emails:[],error:e.message};}),
    loadTasks().catch(e=>{errors.push('Tasks: '+e.message);return [];}),
    recentTranscripts(45).catch(e=>{errors.push('Transcripts: '+e.message);return [];}),
    recentMemoryItems(45,120).catch(e=>{errors.push('Memory: '+e.message);return [];}),
    recentMemoryItems(365,300).catch(()=>[]),
    fetchGhlCalendarEvents(widerPast,future).catch(e=>{errors.push('GHL calendar: '+e.message);return [];}),
    fetchGoogleCalendarEvents(widerPast,future,150).catch(e=>{errors.push('Google calendar: '+e.message);return [];}),
    fetchGhlOpportunities({status:'open',limit:100}).catch(e=>{errors.push('Pipeline: '+e.message);return {data:{opportunities:[]}};})
  ]);
  const preferences=new Map();
  for(const mem of preferenceMemory.filter(m=>m&&m.kind==='relationship_preference').sort((a,b)=>interactionDate(a.createdAt)-interactionDate(b.createdAt))){
    const pref=mem.metadata||parseLeadJson(mem.rawText)||{};const c=pref.contact||{};
    preferences.set(personKey(c.name,c.email),{action:pref.action||'',until:pref.until||'',createdAt:mem.createdAt||''});
  }
  for(const email of (gmail.emails||[]).concat(outlook.emails||[])){
    if(!email) continue;
    if(!isMeaningfulRelationshipEmail(email)) continue;
    const evidence=relationshipEvidence('email',`${email.subject||'(No subject)'}: ${email.snippet||email.bodyPreview||''}`,email.receivedAt||email.date,'high',email.messageId);
    relationshipEmailParticipants(email).filter(person=>!isOwnerRelationship(person,owner)).forEach(person=>addEvidence(touch(person),evidence));
  }
  for(const ev of ghlEvents.concat(googleEvents)){
    if(!ev) continue;
    inferAttendeesFromEvent(ev).forEach(a=>{
      const p=touch({name:a.name,email:a.email});
      addEvidence(p,relationshipEvidence('meeting',`${ev.title||ev.summary||'Meeting'}${ev.startTime?' on '+new Date(ev.startTime).toLocaleDateString('en-US'):''}`,ev.startTime,'high',ev.id));
    });
  }
  for(const task of tasks.filter(t=>t&&!t.completed)){
    const p=touch({name:task.contactName||''});
    if(!p||p.name==='Unknown') continue;
    addEvidence(p,relationshipEvidence('task',task.title+(task.notes?': '+task.notes:''),task.createdAt||task.dueDate,'high',task.id));
  }
  for(const tr of transcripts){
    if(!tr) continue;
    splitPeopleFromText([tr.title,tr.rawText].join(' ')).forEach(person=>{
      const p=touch(person);
      addEvidence(p,relationshipEvidence('transcript',`${tr.title||'Transcript'}: ${String(tr.rawText||'').slice(0,220)}`,tr.createdAt,person.confidence,tr.id));
    });
  }
  for(const mem of memory.filter(m=>m&&m.kind!=='relationship_preference')){
    splitPeopleFromText([mem.summary,mem.rawText].join(' ')).forEach(person=>{
      const p=touch(person);
      addEvidence(p,relationshipEvidence('memory',`${mem.summary||mem.kind}: ${String(mem.rawText||'').slice(0,220)}`,mem.createdAt,person.confidence,mem.id));
    });
  }
  for(const o of (pipeline.data?.opportunities||[])){
    if(!o) continue;
    const c=o.contact||{};
    const p=touch({name:c.name||o.contactName||o.name,email:c.email||o.contactEmail,company:o.name});
    addEvidence(p,relationshipEvidence('opportunity',`${o.name||'Open opportunity'}${o.monetaryValue?' worth $'+o.monetaryValue:''}${o.status?' is '+o.status:''}`,o.updatedAt||o.lastStatusChangeAt,'high',o.id));
  }
  for(const p of new Set(people.values())){
    const introCount=p.evidence.filter(e=>/intro|introduction|connect|referral|referred/i.test(e.summary)).length;
    p.superConnector=introCount>=2;
    if(p.superConnector) p.tags.push('Super Connector');
    p.lastInteractionDays=daysSince(p.lastInteractionAt);
    const pref=preferences.get(personKey(p.name,p.email))||preferences.get(personKey(p.name,''))||{};
    p.manualVip=pref.action==='mark_vip';p.notImportant=pref.action==='not_important';p.snoozedUntil=pref.action==='snooze'?pref.until:'';
    p.scoreBreakdown=relationshipScore(p);
    p.score=p.scoreBreakdown.total;
    if(p.manualVip){p.score=Math.min(100,p.score+20);p.tags.push('VIP');}
    if(p.notImportant)p.score=Math.max(0,p.score-40);
    p.recommendedAction=recommendedRelationshipAction(p);
    p.relationshipType=p.manualVip?'VIP':p.superConnector?'Connector':p.scoreBreakdown.opportunityPotential>=10?'Opportunity':p.company?'Professional':'Personal';
    p.reason=synthesizeRelationshipSummary(p);
    p.draftOutreach=draftRelationshipOutreach(p);
    p.profile=relationshipProfile(p);
  }
  const contacts=[...new Set(people.values())].filter(p=>p.name&&p.name!=='Unknown'&&p.evidence.length&&!isOwnerRelationship(p,owner)&&!p.notImportant&&(!p.snoozedUntil||new Date(p.snoozedUntil)<=now)).sort((a,b)=>b.score-a.score).slice(0,80);
  const topRelationshipPriorities=contacts.slice(0,10);
  const highestLeverageRelationships=contacts.filter(c=>c.scoreBreakdown.strategicImportance>=10||c.superConnector||c.scoreBreakdown.opportunityPotential>=10).slice(0,8);
  const coolingRelationships=contacts.filter(c=>c.lastInteractionDays!==null&&c.lastInteractionDays>=14&&c.score>=35).sort((a,b)=>b.score-a.score).slice(0,8);
  const momentumRelationships=contacts.filter(c=>c.evidence.filter(e=>interactionDate(e.date)>=past.getTime()).length>=2||c.scoreBreakdown.opportunityPotential>=10).slice(0,8);
  const peopleNotContactedRecently=contacts.filter(c=>c.lastInteractionDays!==null&&c.lastInteractionDays>=14).slice(0,10);
  const forgottenCommitments=contacts.flatMap(c=>(c.openLoops||[]).map(loop=>({contact:c.name,score:c.score,commitment:loop,sourceEvidence:c.evidence.find(e=>e.summary.includes(loop.slice(0,30)))||c.evidence[0],recommendedAction:`Close the loop with ${c.name}.`}))).slice(0,12);
  const hiddenOpportunities=contacts.filter(c=>(c.opportunitySignals||[]).length||c.superConnector).slice(0,10).map(c=>({contact:c.name,score:c.score,opportunity:(c.opportunitySignals||[])[0]||(c.superConnector?'Super Connector relationship may reveal introductions or market intelligence.':''),evidence:c.evidence.slice(0,2),recommendedAction:c.recommendedAction}));
  const connectors=contacts.filter(c=>c.superConnector);
  const opportunityPeople=contacts.filter(c=>c.scoreBreakdown.opportunityPotential>=8&&!c.superConnector);
  const suggestedIntroductions=connectors.slice(0,3).flatMap(a=>opportunityPeople.slice(0,3).filter(b=>b.key!==a.key).slice(0,1).map(b=>({personA:a.name,personB:b.name,reason:`${a.name} shows connector/referral signals and ${b.name} has opportunity signals.`,confidence:'low',evidence:[a.evidence[0],b.evidence[0]].filter(Boolean),suggestedIntroMessage:`${a.name}, I thought of you because ${b.name} is working through something that may overlap with your world. Would an introduction be useful?`}))).slice(0,5);
  return {
    ok:true,windowDays,generatedAt:new Date().toISOString(),errors,
    relationshipProfiles:contacts.map(c=>c.profile),
    topRelationshipPriorities,
    highestLeverageRelationships,
    coolingRelationships,
    momentumRelationships,
    peopleNotContactedRecently,
    forgottenCommitments,
    hiddenOpportunities,
    suggestedIntroductions,
    relationshipTaskPriorities:topRelationshipPriorities.map(c=>({contact:c.name,priority:c.score>=70?'High':c.score>=45?'Medium':'Low',tasks:c.openLoops||[],suggestedNextTask:c.recommendedAction,recommendedOutreach:c.draftOutreach})),
    draftCommunications:topRelationshipPriorities.slice(0,8).map(c=>({contact:c.name,score:c.score,draft:c.draftOutreach,evidence:c.evidence.slice(0,2)})),
    priorityReviewIntegration:{highestLeverageRelationship:highestLeverageRelationships[0]||null,top3RelationshipPriorities:topRelationshipPriorities.slice(0,3),oneCoolingRelationship:coolingRelationships[0]||null,oneForgottenCommitment:forgottenCommitments[0]||null,oneSuggestedIntroduction:suggestedIntroductions[0]||null,oneHiddenOpportunity:hiddenOpportunities[0]||null},
    askForAssistance:{question:'Would you like me to help with any of these relationships?',options:['Draft outreach','Create tasks','Brainstorm opportunities','Brainstorm ways to help this person','Prepare for upcoming meeting','Review relationship history']}
  };
}

function mapGoogleEvent(ev){
  return {
    id:ev.id, summary:ev.summary||'(No title)',
    startTime:ev.start?.dateTime||ev.start?.date,
    endTime:ev.end?.dateTime||ev.end?.date,
    location:ev.location||'',
    description:ev.description||'',
    attendees:(ev.attendees||[]).map(a=>({name:a.displayName||'',email:a.email||'',responseStatus:a.responseStatus||'',self:!!a.self,organizer:!!a.organizer})),
    attendeesOmitted:!!ev.attendeesOmitted,
    organizer:ev.organizer?{name:ev.organizer.displayName||'',email:ev.organizer.email||'',self:!!ev.organizer.self}:null,
    creator:ev.creator?{name:ev.creator.displayName||'',email:ev.creator.email||'',self:!!ev.creator.self}:null,
    hangoutLink:ev.hangoutLink||'',
    status:ev.status, source:'google'
  };
}

async function hydrateGoogleEventAttendees(token,ev){
  if(ev.attendees&&ev.attendees.length&&!ev.attendeesOmitted) return ev;
  try{
    const r=await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(ev.id)}?maxAttendees=50`,{headers:{Authorization:`Bearer ${token}`}});
    const full=await r.json();
    if(!full.error) return {...ev,...full};
  }catch(e){console.log('Google event attendee hydrate failed:',e.message);}
  return ev;
}

function extractLinkedInUrl(data){
  const text = JSON.stringify(data||{});
  return (text.match(/https?:\/\/([a-z]+\.)?linkedin\.com\/in\/[^"',\s)]+/i)||[])[0] || '';
}

function extractEmailsFromValue(value){
  const text = typeof value === 'string' ? value : JSON.stringify(value||'');
  const matches = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
  return [...new Set(matches.map(e=>e.toLowerCase())
    .filter(e=>!/\.(png|jpg|jpeg|gif|webp|svg|css|js)$/i.test(e))
    .filter(e=>!/(example|domain|email\.com|sentry|wixpress|wordpress|schema\.org)/i.test(e)))];
}

function firstEmailFrom(...values){
  for(const value of values){
    const found = extractEmailsFromValue(value);
    if(found.length) return found[0];
  }
  return '';
}

function isLikelyPersonEmail(email){
  const local = String(email||'').split('@')[0].toLowerCase();
  if(!local) return false;
  if(/^(info|hello|contact|support|admin|office|team|media|press|help|careers|jobs|webmaster|noreply|no-reply|service|services|customerservice|sales|billing|accounts|dispatch|schedule|scheduling|quotes?|estimating|appointments?|mail|inquiries?)$/.test(local)) return false;
  if(/^(owner|founder|ceo|president|director)$/.test(local)) return false;
  const domain=String(email||'').split('@')[1]||'';
  const freeDomain=/^(gmail|yahoo|outlook|hotmail|icloud|aol)\./i.test(domain);
  if(freeDomain && /(electric|electrical|plumb|plumbing|hvac|heating|cooling|roof|roofing|contract|contractor|construction|service|services|llc|inc|az|phoenix|mesa|chandler|company|shop|repair|drain)/i.test(local)) return false;
  if(/(electric|electrical|plumb|plumbing|hvac|roof|contractor|construction|service|services|llc|inc|company)/i.test(local) && !/[._-]/.test(local)) return false;
  return true;
}

function classifyEmail(email){
  if(!email) return 'missing';
  const local=String(email).split('@')[0].toLowerCase();
  if(isLikelyPersonEmail(email)) return 'person';
  if(/^(sales|partnerships|bizdev|businessdevelopment|hr|humanresources|benefits|operations|ops|owner|founder|ceo|president|director)$/.test(local)) return 'high-value role';
  return 'general';
}

function leadContactability(lead={}){
  const rawEmail=lead.email||lead.verifiedEmail||lead.decisionMakerEmail||lead.decision_maker_email||'';
  const rawPhone=lead.phone||lead.verifiedPhone||lead.decisionMakerPhone||lead.decision_maker_phone||'';
  const hasEmail=validEmail(rawEmail);
  const hasPhone=validPhone(rawPhone);
  let contactabilityStatus='not_contactable';
  if(hasEmail&&hasPhone) contactabilityStatus='full_contactability';
  else if(hasEmail) contactabilityStatus='email_only';
  else if(hasPhone) contactabilityStatus='phone_only';
  return {
    contactabilityStatus,
    hasEmail,
    hasPhone,
    emailEligibility:hasEmail,
    phoneEligibility:hasPhone,
    initialEmailSent:hasEmail,
    email:hasEmail?normalizeEmailAddress(rawEmail):'',
    phone:hasPhone?normalizePhoneNumber(rawPhone):'',
    importable:hasEmail||hasPhone,
    rejectionReason:hasEmail||hasPhone?'':'missing_email_and_phone'
  };
}

function leadContactabilityNote(c){
  if(c.contactabilityStatus==='full_contactability') return 'Email and phone available. Lead eligible for automated email, SMS, AI calling, and manual outreach.';
  if(c.contactabilityStatus==='email_only') return 'Email available. No valid phone number found. Lead eligible for automated email and manual email outreach.';
  if(c.contactabilityStatus==='phone_only') return 'No email address found. Lead did not receive the initial automated email sequence. Lead should enter phone-first outreach workflows and is eligible for AI calling, SMS outreach, and manual calling.';
  return 'No email or phone number was found. Do not create an outreach-ready contact unless company intelligence is strong enough for manual review routing.';
}

function normalizeRocketReachPerson(data){
  const person = data.person || data.profile || data.data || data;
  const emails = extractEmailsFromValue(person);
  const phones = [...new Set(JSON.stringify(person||'').match(/(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g)||[])];
  const company = person.current_employer || person.current_company || person.company || {};
  const companyObj = typeof company === 'object' ? company : {};
  return {
    found: !!(person && Object.keys(person).length),
    id: person.id || person.profile_id || '',
    name: person.name || person.full_name || [person.first_name,person.last_name].filter(Boolean).join(' '),
    title: person.current_title || person.title || person.job_title || '',
    company: typeof company === 'string' ? company : (companyObj.name || companyObj.company_name || ''),
    location: person.location || person.city || '',
    linkedinUrl: person.linkedin_url || person.linkedin || extractLinkedInUrl(person),
    email: emails.find(isLikelyPersonEmail) || emails[0] || '',
    phone: phones[0] || '',
    connections: person.connections || person.num_connections || person.linkedin_connections || null,
    mutualConnections: person.mutual_connections || person.shared_connections || person.common_connections || null,
    companyLinkedInUrl: companyObj.linkedin_url || companyObj.linkedin || person.company_linkedin_url || '',
    companyId: companyObj.id || companyObj.profile_id || person.company_id || '',
    employeeCount: companyObj.employees || companyObj.employee_count || companyObj.num_employees || person.company_employee_count || '',
    companySizeBand: companyObj.size || companyObj.company_size || companyObj.employee_range || '',
    companyDescription: companyObj.description || person.company_description || '',
    companyLocation: companyObj.location || companyObj.city || person.company_location || '',
    companyFoundedYear: companyObj.founded || companyObj.founded_year || person.company_founded_year || '',
    rawPreview: JSON.stringify(person).slice(0,1400)
  };
}

async function lookupRocketReach(attendee){
  const rocketReachKey=await resolveIntegrationSecret('rocketreach','api_key',ROCKETREACH_API_KEY);
  if(!rocketReachKey) return {configured:false, error:'ROCKETREACH_API_KEY is not set'};
  if(Date.now()<rocketReachLimitedUntil) return {configured:true, error:'RocketReach rate-limited; skipped to protect quota'};
  const params = new URLSearchParams();
  if(attendee.email) params.set('email',attendee.email);
  if(attendee.linkedinUrl) params.set('linkedin_url',attendee.linkedinUrl);
  if(attendee.name) params.set('name',attendee.name);
  if(attendee.company) params.set('current_employer',attendee.company);
  if(attendee.title || attendee.currentTitle) params.set('current_title',attendee.title || attendee.currentTitle);
  const url = `${ROCKETREACH_BASE_URL.replace(/\/$/,'')}/person/lookup?${params.toString()}`;
  const response = await fetch(url,{headers:{'Api-Key':rocketReachKey}});
  const data = await readJsonResponse(response);
  if(response.status===429){
    rocketReachLimitedUntil = Date.now() + 10*60*1000;
    return {configured:true, error:'RocketReach 429 rate limit'};
  }
  if(!response.ok) return {configured:true, error:data.message || data.error || `RocketReach ${response.status}`};
  return {configured:true, data:normalizeRocketReachPerson(data)};
}

async function lookupRocketReachDecisionMaker(company,lead={}){
  const titles=[
    'Owner',
    'Founder',
    'CEO',
    'President',
    'Director of Operations'
  ];
  if(lead.decisionMakerName || lead.linkedinPersonalUrl || isLikelyPersonEmail(lead.email)){
    const exact=await lookupRocketReach({
      name:lead.decisionMakerName,
      company,
      email:isLikelyPersonEmail(lead.email)?lead.email:'',
      linkedinUrl:lead.linkedinPersonalUrl
    }).catch(e=>({configured:!!ROCKETREACH_API_KEY,error:e.message}));
    if(exact.data?.name || exact.data?.email || exact.data?.phone) return {...exact,matchTitle:lead.decisionMakerTitle||''};
  }
  for(const title of titles){
    const rr=await lookupRocketReach({company,name:'',title,currentTitle:title}).catch(e=>({configured:!!ROCKETREACH_API_KEY,error:e.message}));
    if(rr.error && /rate limit/i.test(rr.error)) return rr;
    if(rr.data?.name || rr.data?.email || rr.data?.phone) return {...rr,matchTitle:title};
  }
  return {configured:!!(await resolveIntegrationSecret('rocketreach','api_key',ROCKETREACH_API_KEY).catch(()=>'')), error:'No decision-maker match found'};
}

function normalizeCompanyForMatch(value){
  return String(value||'')
    .toLowerCase()
    .replace(/&/g,' and ')
    .replace(/\b(inc|incorporated|llc|l\.l\.c|ltd|limited|corp|corporation|co|company|pllc|pc|pa|llp|lp)\b/g,' ')
    .replace(/[^a-z0-9]+/g,' ')
    .replace(/\s+/g,' ')
    .trim();
}

function apolloPersonTitles(){
  return [
    'Owner',
    'Founder',
    'CEO',
    'President',
    'Managing Partner',
    'Partner',
    'Principal',
    'Practice Owner',
    'Executive Director',
    'General Manager',
    'Operations Manager',
    'Director of Operations',
    'HR Director',
    'Human Resources Director',
    'Office Manager'
  ];
}

function normalizeApolloPerson(person,lead={}){
  const org=person.organization || person.account || person.current_organization || {};
  const name=person.name || person.full_name || [person.first_name,person.last_name].filter(Boolean).join(' ');
  return {
    found:!!(name || person.linkedin_url || person.title),
    id:person.id || person.person_id || '',
    name:name||'',
    title:person.title || person.current_title || person.headline || '',
    company:org.name || person.organization_name || person.company || '',
    companyDomain:org.primary_domain || org.website_url || org.domain || leadDomain(lead.website||''),
    linkedinUrl:person.linkedin_url || person.linkedin || '',
    city:person.city || '',
    state:person.state || '',
    country:person.country || '',
    emailStatus:person.email_status || person.contact_email_status || '',
    rawPreview:JSON.stringify(person).slice(0,1400)
  };
}

function scoreApolloPerson(person,lead){
  let score=0;
  const title=String(person.title||'').toLowerCase();
  if(/\b(owner|founder|ceo|chief executive|president)\b/.test(title)) score+=100;
  else if(/\b(managing partner|partner|principal|practice owner|executive director)\b/.test(title)) score+=85;
  else if(/\b(operations|general manager|office manager|human resources|hr director)\b/.test(title)) score+=60;
  else if(/\b(manager|director)\b/.test(title)) score+=35;
  const targetDomain=leadDomain(lead.website||'');
  const personDomain=leadDomain(person.companyDomain||'');
  if(targetDomain && personDomain && targetDomain===personDomain) score+=120;
  const targetCompany=normalizeCompanyForMatch(lead.organizationName||lead.name||'');
  const personCompany=normalizeCompanyForMatch(person.company||'');
  if(targetCompany && personCompany){
    if(targetCompany===personCompany) score+=90;
    else if(targetCompany.includes(personCompany) || personCompany.includes(targetCompany)) score+=55;
  }
  if(person.linkedinUrl) score+=12;
  if(person.name) score+=10;
  return score;
}

async function lookupApolloDecisionMaker(lead={}){
  const apolloKey=await resolveIntegrationSecret('apollo','api_key',APOLLO_API_KEY);
  if(!apolloKey) return {configured:false,error:'APOLLO_API_KEY is not set'};
  const domain=leadDomain(lead.website||'');
  const company=lead.organizationName||lead.name||'';
  const params=new URLSearchParams();
  apolloPersonTitles().forEach(title=>params.append('person_titles[]',title));
  ['owner','founder','c_suite','partner','vp','head','director','manager'].forEach(s=>params.append('person_seniorities[]',s));
  if(domain) params.append('q_organization_domains_list[]',domain);
  if(!domain && company) params.set('q_keywords',company);
  if(lead.state) params.append('organization_locations[]',lead.state);
  else if(lead.location) params.append('organization_locations[]',lead.location);
  params.set('include_similar_titles','false');
  params.set('page','1');
  params.set('per_page','10');
  const url=`${APOLLO_BASE_URL.replace(/\/$/,'')}/mixed_people/api_search?${params.toString()}`;
  const response=await fetch(url,{
    method:'POST',
    headers:{
      accept:'application/json',
      'Content-Type':'application/json',
      'x-api-key':apolloKey,
      Authorization:`Bearer ${apolloKey}`
    }
  });
  const data=await readJsonResponse(response);
  if(!response.ok) return {configured:true,error:data.message || data.error || `Apollo ${response.status}`};
  const rawPeople=[...(data.people||[]),...(data.contacts||[]),...(data.persons||[])];
  const people=rawPeople.map(p=>normalizeApolloPerson(p,lead)).filter(p=>p.found);
  const ranked=people
    .map(p=>({...p,matchScore:scoreApolloPerson(p,lead)}))
    .filter(p=>p.matchScore>=70 || (domain && leadDomain(p.companyDomain||'')===domain))
    .sort((a,b)=>b.matchScore-a.matchScore);
  if(!ranked.length) return {configured:true,error:'Apollo did not find a confident decision-maker match',rawCount:rawPeople.length};
  return {configured:true,data:ranked[0],candidates:ranked.slice(0,3),rawCount:rawPeople.length};
}

async function enrichProspectWithApollo(p){
  if(p.decisionMakerName || p.linkedinPersonalUrl) return p;
  const apollo=await lookupApolloDecisionMaker(p).catch(e=>({configured:!!APOLLO_API_KEY,error:e.message}));
  const data=apollo?.data||{};
  if(!data.name && !data.linkedinUrl){
    return {
      ...p,
      apollo,
      apolloStatus:apollo?.error||'Apollo did not return a decision-maker'
    };
  }
  return {
    ...p,
    decisionMakerName:p.decisionMakerName||data.name||'',
    decisionMakerTitle:p.decisionMakerTitle||data.title||'',
    linkedinPersonalUrl:p.linkedinPersonalUrl||data.linkedinUrl||'',
    linkedinMatchConfidence:data.matchScore>=160?'high':'medium',
    linkedinMatchNotes:`Apollo matched ${data.name||'a likely contact'}${data.title?' - '+data.title:''}${data.company?' at '+data.company:''}`,
    apollo,
    apolloStatus:`matched ${data.name||'likely decision-maker'}${data.title?' - '+data.title:''}`
  };
}

async function lookupOutscraperLinkedIn(attendee, profile){
  const outscraperKey=await resolveIntegrationSecret('outscraper','api_key',OUTSCRAPER_API_KEY);
  if(!outscraperKey) return {configured:false, error:'OUTSCRAPER_API_KEY is not set'};
  if(!OUTSCRAPER_LINKEDIN_POSTS_URL) return {configured:false, error:'OUTSCRAPER_LINKEDIN_POSTS_URL is not set'};
  const url = new URL(OUTSCRAPER_LINKEDIN_POSTS_URL);
  const query = profile?.linkedinUrl || attendee.linkedinUrl || attendee.email || attendee.name;
  if(query) url.searchParams.set('query', query);
  url.searchParams.set('async','false');
  const response = await fetch(url.toString(),{headers:{'X-API-KEY':outscraperKey}});
  const data = await readJsonResponse(response);
  if(!response.ok) return {configured:true, error:data.errorMessage || data.message || `Outscraper ${response.status}`};
  const posts = Array.isArray(data.data) ? data.data.flat(3).filter(Boolean) : [];
  const weekAgo = Date.now() - 7*24*60*60*1000;
  const recentPosts = posts.filter(p=>{
    const rawDate = p.date || p.posted_at || p.created_at || p.time || p.timestamp;
    const time = rawDate ? new Date(rawDate).getTime() : NaN;
    return !Number.isFinite(time) || time >= weekAgo;
  }).slice(0,6).map(p=>({
    date:p.date || p.posted_at || p.created_at || '',
    text:String(p.text || p.post_text || p.content || p.description || p.title || '').slice(0,700),
    url:p.url || p.post_url || p.link || ''
  }));
  return {configured:true, postsLastWeek:recentPosts, rawCount:posts.length};
}

app.post('/api/val/meeting-intel',async(req,res)=>{
  try{
    const event = req.body.event || req.body || {};
    const attendees = inferAttendeesFromEvent(event);
    const enriched = [];
    for(const attendee of attendees){
      const rocket = await lookupRocketReach(attendee).catch(e=>({configured:!!ROCKETREACH_API_KEY,error:e.message}));
      const profile = rocket.data || {};
      const outscraper = await lookupOutscraperLinkedIn(attendee,profile).catch(e=>({configured:!!OUTSCRAPER_API_KEY,error:e.message}));
      enriched.push({attendee, rocketReach:rocket, outscraper});
    }
    res.json({ok:true, attendees:enriched, missingConfig:{
      rocketReach:!ROCKETREACH_API_KEY
    }, optionalConfig:{
      outscraperConfigured:!!OUTSCRAPER_API_KEY && !!OUTSCRAPER_LINKEDIN_POSTS_URL
    }});
  }catch(e){ res.status(500).json({error:e.message}); }
});

// ════════════════════════════════════════════════════════
// DASHBOARD ENDPOINTS (called by VAL on load)
// ════════════════════════════════════════════════════════

app.get('/api/meetings',async(req,res)=>{
  try{
    if(DEMO_MODE){
      const events=demoState(req,res).calendarEvents||[];
      const today=events.filter(e=>new Date(e.startTime).toDateString()===new Date().toDateString()).sort((a,b)=>new Date(a.startTime)-new Date(b.startTime));
      return res.json({meetingsToday:today.length,appointments:today,calendarSource:'demo',calendarId:'demo-calendar',_debug:{demo:true,googleCount:today.filter(e=>e.source==='google').length,ghlCount:today.filter(e=>e.source==='ghl').length,valCount:today.filter(e=>e.source==='val').length}});
    }
    const s=new Date();s.setHours(0,0,0,0);
    const e=new Date();e.setHours(23,59,59,999);

    const [ghlRes,googleRes,outlookRes,valRes] = await Promise.allSettled([
      fetchGhlCalendarEvents(s,e),
      fetchGoogleCalendarEvents(s,e,25),
      fetchOutlookCalendarEvents(s,e,25),
      fetchValCalendarEvents(s,e)
    ]);

    const ghlEvents = ghlRes.status==='fulfilled' ? ghlRes.value : [];
    const googleEvents = googleRes.status==='fulfilled' ? googleRes.value : [];
    const outlookEvents = outlookRes.status==='fulfilled' ? outlookRes.value : [];
    const valEvents = valRes.status==='fulfilled' ? valRes.value : [];
    const allEvents=[...ghlEvents,...googleEvents,...outlookEvents,...valEvents];
    allEvents.sort((a,b)=>new Date(a.startTime)-new Date(b.startTime));
    res.json({meetingsToday:allEvents.length, appointments:allEvents, calendarSource:'ghl+google+outlook+val', calendarId:GHL_CALENDAR_ID, _debug:{ghlCount:ghlEvents.length, googleCount:googleEvents.length, outlookCount:outlookEvents.length, valCount:valEvents.length, googleNeedsAuth:googleRes.status==='rejected', outlookNeedsAuth:outlookRes.status==='rejected'}});
  }catch(e){
    console.error('meetings error:',e);
    res.json({meetingsToday:0,appointments:[]});
  }
});

async function fetchGhlOpportunities({status='open',limit=100}={}){
  return ghlMcp.findOpenOpportunities({status,limit});
}
async function fetchGhlOpportunitiesForAccount(account,{status='open',limit=100}={}){
  return ghlMcp.findOpenOpportunitiesForAccount(account,{status,limit});
}

async function fetchContactNotesForAccount(account,contactId,limit=25){
  if(!contactId)return [];
  const encoded=encodeURIComponent(contactId);
  const paths=[
    `/contacts/${encoded}/notes`,
    `/contacts/${encoded}/notes?locationId=${encodeURIComponent(account.locationId)}`,
    `/contacts/notes?contactId=${encoded}&locationId=${encodeURIComponent(account.locationId)}`
  ];
  for(const path of paths){
    const r=await ghlTryForAccount(account,'GET',path);
    const notes=normalizeNotesPayload(r.data).map(noteBody).filter(Boolean);
    if(r.ok&&notes.length)return notes.slice(0,limit);
  }
  return [];
}

async function enrichGhlOpportunityForAccount(o,account,now=Date.now()){
  const stage=o.pipelineStage?.name||o.stage?.name||o.stageName||o.pipelineStage||'Unknown Stage';
  const contactId=o.contact?.id||o.contactId;
  let notes=[];
  let contactEmail='';
  let contactPhone='';
  try{
    if(contactId){
      const [noteRows,contactData]=await Promise.all([
        fetchContactNotesForAccount(account,contactId,20),
        ghlForAccount(account,'GET',`/contacts/${contactId}`)
      ]);
      notes=noteRows;
      contactEmail=contactData.contact?.email||'';
      contactPhone=contactData.contact?.phone||'';
    }
  }catch(e){console.log(`contact enrich error (${account.label}):`,e.message);}
  return {
    id:o.id,
    name:o.name,
    status:o.status,
    stage,
    value:o.monetaryValue,
    contactName:o.contact?.name||o.contactName||'',
    contactId,
    contactEmail,
    contactPhone,
    accountSlug:account.slug,
    accountLabel:account.label,
    owner:inferValOwner(o),
    notes,
    updatedAt:o.updatedAt,
    daysInStage:Math.floor((now-new Date(o.lastStatusChangeAt||o.updatedAt).getTime())/(24*60*60*1000)),
    stalled:(now-new Date(o.lastStatusChangeAt||o.updatedAt).getTime())>14*24*60*60*1000
  };
}

app.get('/api/pipeline',async(req,res)=>{
  try{
    if(DEMO_MODE){
      const opps=demoState(req,res).opportunities||[];
      return res.json({pipelineActive:opps.filter(o=>o.status==='open').length,stalledDeals:opps.filter(o=>o.stalled).length,opportunities:opps,_debug:{configured:true,demo:true}});
    }
    const accounts=await resolvedGhlAccounts();
    if(!accounts.length){
      return res.json({pipelineActive:0,stalledDeals:0,opportunities:[],_debug:{configured:false,error:'Missing GHL account configuration'}});
    }
    const now=Date.now();
    const batches=await Promise.allSettled(accounts.map(async account=>{
      const found=await fetchGhlOpportunitiesForAccount(account,{status:'open',limit:100});
      const opps=found.data?.opportunities||[];
      const enriched=await mapWithConcurrency(opps,6,o=>enrichGhlOpportunityForAccount(o,account,now));
      return {account,path:found.path,attempts:found.attempts,opportunities:enriched,total:found.data?.meta?.total||opps.length};
    }));
    const successful=batches.filter(b=>b.status==='fulfilled').map(b=>b.value);
    const errors=batches.filter(b=>b.status==='rejected').map((b,i)=>({account:accounts[i]?.label,error:b.reason?.message||String(b.reason)}));
    const enriched=successful.flatMap(b=>b.opportunities);
    const stalled=enriched.filter(o=>o.stalled);
    res.json({pipelineActive:successful.reduce((n,b)=>n+b.total,0)||enriched.length,stalledDeals:stalled.length,opportunities:enriched,_debug:{configured:true,accounts:successful.map(b=>({slug:b.account.slug,label:b.account.label,count:b.opportunities.length,path:b.path,attempts:b.attempts})),errors}});
  }catch(e){console.error('pipeline error:',e);res.json({pipelineActive:0,stalledDeals:0,opportunities:[],_debug:{error:e.message}});}
});

app.get('/api/debug/ghl-pipeline',async(req,res)=>{
  try{
    const ghlKey=await resolveIntegrationSecret('ghl','api_key',GHL_KEY);
    const ghlLoc=await resolveGhlLocationId();
    if(!ghlKey||!ghlLoc){
      return res.json({configured:false,error:'Missing GHL_KEY or GHL_LOC'});
    }
    const found=await fetchGhlOpportunities({status:req.query.status||'open',limit:Number(req.query.limit||100)});
    res.json({
      configured:true,
      locationId:ghlLoc,
      selectedPath:found.path,
      attempts:found.attempts,
      count:(found.data.opportunities||[]).length,
      sample:(found.data.opportunities||[]).slice(0,3).map(o=>({
        id:o.id,
        name:o.name,
        contactName:o.contact?.name||o.contactName,
        contactId:o.contact?.id||o.contactId,
        status:o.status,
        stage:o.pipelineStage?.name||o.stage?.name||o.stageName||o.pipelineStage,
        pipelineId:o.pipelineId,
        pipelineStageId:o.pipelineStageId
      }))
    });
  }catch(e){
    res.json({configured:!!(GHL_KEY&&GHL_LOC),error:e.message});
  }
});

app.get('/api/debug/ghl-mcp-context',async(req,res)=>{
  try{
    const query=String(req.query.query||req.query.q||'').trim()||'recent contacts opportunities tasks';
    const context=await ghlMcp.buildContext(query,{
      limit:Math.min(Number(req.query.limit)||5,12),
      opportunityLimit:Math.min(Number(req.query.opportunityLimit)||10,25),
      taskLimit:Math.min(Number(req.query.taskLimit)||5,15),
      notesLimit:Math.min(Number(req.query.notesLimit)||3,10)
    });
    res.json({ok:true,configured:await ghlMcp.isConfigured(),query,...context});
  }catch(e){
    res.status(500).json({ok:false,configured:await ghlMcp.isConfigured().catch(()=>false),error:e.message});
  }
});

app.get('/api/calendar',async(req,res)=>{
  try{
    if(DEMO_MODE){
      const mapped=(demoState(req,res).calendarEvents||[]).slice().sort((a,b)=>new Date(a.startTime)-new Date(b.startTime));
      return res.json({calendarEvents:mapped,calendarSource:'demo',calendarId:'demo-calendar',_debug:{demo:true,ghlCount:mapped.filter(e=>e.source==='ghl').length,googleCount:mapped.filter(e=>e.source==='google').length,valCount:mapped.filter(e=>e.source==='val').length}});
    }
    const s=new Date();s.setHours(0,0,0,0);
    const e=new Date();e.setDate(e.getDate()+7);e.setHours(23,59,59,999);

    const [ghlRes,googleRes,outlookRes,valRes] = await Promise.allSettled([
      fetchGhlCalendarEvents(s,e),
      fetchGoogleCalendarEvents(s,e,75),
      fetchOutlookCalendarEvents(s,e,75),
      fetchValCalendarEvents(s,e)
    ]);

    const ghlEvents = ghlRes.status==='fulfilled'?ghlRes.value:[];
    const googleEvents = googleRes.status==='fulfilled'?googleRes.value:[];
    const outlookEvents = outlookRes.status==='fulfilled'?outlookRes.value:[];
    const valEvents = valRes.status==='fulfilled'?valRes.value:[];

    console.log(`Calendar: ${ghlEvents.length} GHL events across ${configuredGhlAccounts().length||0} accounts; ${googleEvents.length} Google events; ${outlookEvents.length} Outlook events; ${valEvents.length} VAL retro events`);

    const mapped = [...ghlEvents,...googleEvents,...outlookEvents,...valEvents];
    mapped.sort((a,b)=>new Date(a.startTime)-new Date(b.startTime));
    res.json({
      calendarEvents:mapped,
      calendarSource:'ghl+google+outlook+val',
      calendarId:GHL_CALENDAR_ID,
      _debug:{ghlCount:ghlEvents.length, googleCount:googleEvents.length, outlookCount:outlookEvents.length, valCount:valEvents.length, googleNeedsAuth:googleRes.status==='rejected', outlookNeedsAuth:outlookRes.status==='rejected'}
    });
  }catch(e){
    console.error('calendar error:',e);
    res.json({calendarEvents:[],_debug:{error:e.message}});
  }
});

function sidebarCalendarWindow(req){
  const startParam=String(req.query.start||'').trim();
  const endParam=String(req.query.end||'').trim();
  const start=startParam?new Date(`${startParam}T00:00:00`):new Date();
  start.setHours(0,0,0,0);
  const end=endParam?new Date(`${endParam}T23:59:59`):new Date(start);
  if(!endParam) end.setDate(end.getDate()+7);
  end.setHours(23,59,59,999);
  return {start,end};
}

function normalizeSidebarCalendarEvent(ev,source){
  const start=ev.startTime||ev.start_time||(typeof ev.start==='string'?ev.start:(ev.start&&(ev.start.dateTime||ev.start.date)))||ev.date||'';
  const end=ev.endTime||ev.end_time||(typeof ev.end==='string'?ev.end:(ev.end&&(ev.end.dateTime||ev.end.date)))||'';
  return {
    id:ev.id||ev.eventId||ev.appointmentId||'',
    title:ev.title||ev.summary||ev.name||'(No title)',
    start,
    end,
    attendees:Array.isArray(ev.attendees)?ev.attendees:[],
    organizer:ev.organizer||{},
    location:ev.location||'',
    meetingLink:ev.meetingLink||ev.hangoutLink||ev.webLink||'',
    status:ev.status||'',
    source,
    raw:ev.raw||ev
  };
}

app.get('/api/calendar/sidebar',async(req,res)=>{
  const errors=[];
  try{
    const {start,end}=sidebarCalendarWindow(req);
    if(DEMO_MODE){
      const events=(demoState(req,res).calendarEvents||[])
        .filter(ev=>new Date(ev.startTime||ev.start||0)>=start&&new Date(ev.startTime||ev.start||0)<=end)
        .sort((a,b)=>new Date(a.startTime||a.start)-new Date(b.startTime||b.start))
        .map(ev=>normalizeSidebarCalendarEvent(ev,'demo'));
      return res.json({ok:true,source:'demo',events,errors});
    }

    // Future-ready: add a user calendar preference here. For now, Google wins if both are connected.
    const googleToken=await getGoogleToken();
    if(googleToken){
      try{
        const events=(await fetchGoogleCalendarEvents(start,end,75))
          .sort((a,b)=>new Date(a.startTime)-new Date(b.startTime))
          .map(ev=>normalizeSidebarCalendarEvent(ev,'google'));
        return res.json({ok:true,source:'google',events,errors});
      }catch(e){
        errors.push('Google Calendar needs to be reconnected.');
        return res.json({ok:true,source:'google',events:[],errors,needsReconnect:'google'});
      }
    }

    try{
      const events=(await fetchOutlookCalendarEvents(start,end,75))
        .sort((a,b)=>new Date(a.startTime)-new Date(b.startTime))
        .map(ev=>normalizeSidebarCalendarEvent(ev,'outlook'));
      return res.json({ok:true,source:'outlook',events,errors});
    }catch(e){
      const hasMicrosoftTokens=!!(await loadOAuthTokens('microsoft').catch(()=>null));
      if(hasMicrosoftTokens){
        errors.push('Outlook Calendar needs to be reconnected.');
        return res.json({ok:true,source:'outlook',events:[],errors,needsReconnect:'outlook'});
      }
    }

    errors.push('Connect Google Calendar or Outlook Calendar to show your schedule here.');
    return res.json({ok:true,source:'none',events:[],errors});
  }catch(e){
    res.json({ok:true,source:'error',events:[],errors:[e.message||'Calendar could not load.']});
  }
});

// Debug endpoint — raw calendar responses
app.get('/api/debug/calendar',async(req,res)=>{
  try{
    const s=new Date();s.setHours(0,0,0,0);
    const e=new Date();e.setDate(e.getDate()+7);e.setHours(23,59,59,999);

    const [c1,c2,c3] = await Promise.allSettled([
      ghl('GET',`/calendars/?locationId=${GHL_LOC}`),
      ghl('GET',`/calendars/groups?locationId=${GHL_LOC}`),
      ghl('GET',`/users/search?locationId=${GHL_LOC}&limit=10`)
    ]);

    const calendars = c1.status==='fulfilled'?(c1.value.calendars||[]):[];
    const groups = c2.status==='fulfilled'?(c2.value.groups||[]):[];

    // Try fetching events for first calendar if any
    let sampleEvents=[];
    if(calendars.length){
      try{
        const d=await ghl('GET',`/calendars/events?locationId=${GHL_LOC}&calendarId=${calendars[0].id}&startTime=${s.getTime()}&endTime=${e.getTime()}`);
        sampleEvents=(d.events||d.appointments||[]).slice(0,3).map(ev=>({title:ev.title||ev.name,start:ev.startTime||ev.start}));
      }catch(err){}
    }

    const token=await getGoogleToken();
    let googleRaw={needsAuth:true};
    if(token){
      const r=await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${s.toISOString()}&timeMax=${e.toISOString()}&singleEvents=true&orderBy=startTime&maxResults=5`,{headers:{Authorization:`Bearer ${token}`}});
      googleRaw=await r.json();
    }

    res.json({
      timeRange:{start:s.toISOString(),end:e.toISOString()},
      calendars: calendars.map(c=>({id:c.id,name:c.name,type:c.calendarType})),
      groups: groups.map(g=>({id:g.id,name:g.name})),
      sampleEvents,
      users: c3.status==='fulfilled'?{count:(c3.value.users||[]).length,keys:Object.keys(c3.value)}:{error:c3.reason?.message},
      google:{hasToken:!!token,itemsCount:(googleRaw.items||[]).length,needsAuth:!!googleRaw.needsAuth,error:googleRaw.error?.message,items:(googleRaw.items||[]).map(i=>({summary:i.summary,start:i.start}))}
    });
  }catch(e){res.json({error:e.message});}
});

// ── TASK INGEST — Make webhook posts tasks here, interface polls them ──
let injectedTasks = [];

app.post('/api/tasks/ingest', (req, res) => {
  try {
    const body = req.body;
    const now = new Date();
    // Accept Make's task payload: {contact_id, first_name, last_name, customData:{task,details}}
    // OR an array of tasks, OR legacy {title, contactName...} shape
    const incoming = Array.isArray(body) ? body : [body];
    const normalized = incoming
      .filter(t => t && (t.customData?.task || t.title || t.name))
      .map(t => {
        const isMakeShape = !!t.customData;
        return {
          id:          t.id || ('inj_' + Date.now() + '_' + Math.random().toString(36).slice(2)),
          title:       isMakeShape ? t.customData.task : (t.title || t.name),
          contactName: isMakeShape ? ((t.first_name||'') + ' ' + (t.last_name||'')).trim() : (t.contactName || t.contact_name || ''),
          contactId:   t.contact_id || t.contactId || '',
          dueDate:     isMakeShape ? t.customData.details : (t.dueDate || t.due_date || null),
          status:      t.status || 'open',
          source:      'make',
          injectedAt:  now.toISOString(),
          overdue:     false,
        };
      });
    normalized.forEach(inc => {
      const idx = injectedTasks.findIndex(t => t.id === inc.id);
      if (idx >= 0) injectedTasks[idx] = inc;
      else injectedTasks.push(inc);
    });
    injectedTasks = injectedTasks.filter(t => t.status !== 'completed' && t.status !== 'done');
    console.log(`tasks/ingest: received ${normalized.length}, total stored: ${injectedTasks.length}`);
    res.json({ ok: true, received: normalized.length, total: injectedTasks.length });
  } catch(e) {
    console.error('tasks/ingest error:', e);
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/tasks',async(req,res)=>{
  try{
    const now=new Date();
    const allTasks=await loadTasks();
    const open=allTasks.filter(t=>!t.completed);
    const overdue=open.filter(t=>t.dueDate&&new Date(t.dueDate)<now);
    res.json({openTasks:open.length,overdueTasks:overdue.length,source:'val',tasks:open.slice(0,100).map(t=>({...t,overdue:!!(t.dueDate&&new Date(t.dueDate)<now)}))});
  }catch(e){
    console.error('tasks error:',e);
    res.json({openTasks:0,overdueTasks:0,tasks:[],error:e.message});
  }
});

// Debug endpoint — tasks
app.get('/api/debug/tasks',async(req,res)=>{
  try{
    // Test contacts fetch several ways
    const [cRes1, cRes2, cRes3] = await Promise.allSettled([
      ghl('GET',`/contacts/?locationId=${GHL_LOC}&limit=5`),
      ghl('GET',`/contacts?locationId=${GHL_LOC}&limit=5`),
      ghl('GET',`/contacts/?locationId=${GHL_LOC}&limit=5&sortBy=date_added&sortDirection=desc`),
    ]);
    const fmtC=r=>r.status==='fulfilled'?{keys:Object.keys(r.value),count:(r.value.contacts||[]).length,first:(r.value.contacts||[])[0]?.id}:{error:r.reason?.message};

    // Test known contact task fetch (VAL contact from pipeline)
    const knownContactId='c2tu9Oh6ybL2WMQ5PVJQ';
    let knownContactTasks=null;
    try{
      const ct=await ghl('GET',`/contacts/${knownContactId}/tasks`);
      knownContactTasks={keys:Object.keys(ct),raw:ct};
    }catch(e){knownContactTasks={error:e.message};}

    // Try a broader contacts search
    let allContactsTest=null;
    try{
      const ac=await ghl('GET',`/contacts/?locationId=${GHL_LOC}&limit=100`);
      allContactsTest={count:(ac.contacts||[]).length,keys:Object.keys(ac),ids:(ac.contacts||[]).slice(0,5).map(c=>c.id)};
    }catch(e){allContactsTest={error:e.message};}

    res.json({
      contactsV1:fmtC(cRes1),
      contactsV2:fmtC(cRes2),
      contactsV3:fmtC(cRes3),
      allContactsTest,
      knownContactTasks,
      knownContactId
    });
  }catch(e){res.json({error:e.message});}
});

app.get('/api/proposals',async(req,res)=>{
  try{
    if(DEMO_MODE){
      const proposals=[
        {id:'demo-prop-1',title:'Atlas Operations Pilot',status:'viewed',stage:'viewed',contactName:'Marcus Chen',value:48000,viewCount:4,sentAt:demoIso(-2,10,0),url:VAL_SIGNUP_URL},
        {id:'demo-prop-2',title:'Northstar Advisory Scope',status:'draft',stage:'draft',contactName:'Elena Brooks',value:85000,viewCount:0,sentAt:null,url:VAL_SIGNUP_URL},
        {id:'demo-prop-3',title:'HealthBridge Renewal',status:'sent',stage:'sent',contactName:'Priya Raman',value:32000,viewCount:1,sentAt:demoIso(-7,9,0),url:VAL_SIGNUP_URL}
      ];
      return res.json({total:2,draft:1,sent:1,viewed:1,signed:0,allCount:proposals.length,proposals,waiting:proposals.filter(p=>['sent','viewed'].includes(p.stage))});
    }
    // Fetch all status groups in parallel using the correct endpoint
    const statusGroups={
      draft:['draft'],
      sent:['sent'],
      viewed:['viewed'],
      signed:['completed','accepted']  // 'signed' is not valid per GHL
    };

    const results=await Promise.allSettled(
      Object.entries(statusGroups).map(async([stage,statuses])=>{
        const statusParams=statuses.map(s=>`status[]=${s}`).join('&');
        const d=await ghl('GET',`/proposals/document?locationId=${GHL_LOC}&${statusParams}&skip=0&limit=20`);
        console.log(`proposals ${stage}:`,JSON.stringify(d).substring(0,200));
        const docs=d.documents||d.proposals||d.data||d.list||[];
        return {stage, docs};
      })
    );

    const byStage={draft:[],sent:[],viewed:[],signed:[]};
    results.forEach(r=>{
      if(r.status==='fulfilled'){
        const {stage,docs}=r.value;
        byStage[stage]=docs.map(d=>({
          id:d.id||d._id,
          title:d.name||d.title||d.documentName||'Proposal',
          status:d.status,
          stage,
          contactName:d.contactName||d.contact?.name||d.recipientName||'',
          value:d.amount||d.total||d.value||0,
          viewCount:d.viewCount||d.views||d.openCount||0,
          sentAt:d.sentAt||d.updatedAt||d.createdAt,
          signedAt:d.signedAt||d.completedAt||null,
          url:`https://app.gohighlevel.com/v2/location/${GHL_LOC}/payments/proposals-estimates`
        }));
      }
    });

    const all=[...byStage.draft,...byStage.sent,...byStage.viewed,...byStage.signed];
    const waiting=[...byStage.sent,...byStage.viewed];

    res.json({
      total:waiting.length,
      draft:byStage.draft.length,
      sent:byStage.sent.length,
      viewed:byStage.viewed.length,
      signed:byStage.signed.length,
      allCount:all.length,
      proposals:all,
      waiting
    });
  }catch(e){
    console.error('proposals error:',e);
    res.json({total:0,draft:0,sent:0,viewed:0,signed:0,proposals:[],error:e.message});
  }
});

app.get('/api/debug/proposals',async(req,res)=>{
  const results={};
  const endpoints=[
    `/proposals/document?locationId=${GHL_LOC}&limit=10`,
    `/proposals/document?locationId=${GHL_LOC}&status[]=draft&limit=10`,
    `/proposals/document?locationId=${GHL_LOC}&status[]=sent&limit=10`,
    `/proposals/document?locationId=${GHL_LOC}&status[]=completed&limit=10`,
    `/proposals/document?locationId=${GHL_LOC}&status[]=viewed&limit=10`,
  ];
  await Promise.all(endpoints.map(async ep=>{
    try{const d=await ghl('GET',ep);results[ep]={status:'ok',keys:Object.keys(d),count:(d.documents||d.data||d.list||[]).length,sample:JSON.stringify(d).substring(0,300)};}
    catch(e){results[ep]={status:'error',message:e.message};}
  }));
  res.json(results);
});

// ── DEBUG: first unread conversation messages ──────────
app.get('/api/debug/conversation',async(req,res)=>{
  try{
    const d=await ghl('GET',`/conversations/search?locationId=${GHL_LOC}&limit=10`);
    const convos=d.conversations||[];
    const unread=convos.filter(c=>c.unreadCount>0);
    if(!unread.length) return res.json({error:'No unread conversations found', total:convos.length});
    const first=unread[0];
    const msgs=await ghl('GET',`/conversations/${first.id}/messages?limit=10`);
    res.json({
      conversationId:first.id,
      contactName:first.contactName,
      unreadCount:first.unreadCount,
      rawConversation:first,
      rawMessages:msgs
    });
  }catch(e){res.status(500).json({error:e.message});}
});

// ── CONVERSATION THREAD ────────────────────────────────
app.get('/api/conversation/:id',async(req,res)=>{
  const id=req.params.id;
  if(DEMO_MODE){
    const s=demoState(req,res);
    const conv=(s.conversations||[]).find(c=>c.id===id)||{};
    const messages=s.messages?.[id]||[];
    return res.json({id,contactName:conv.contactName||'Contact',contactId:conv.contactId||'',type:conv.type||'demo',unreadCount:conv.unreadCount||conv.unread||0,lastMessageBody:conv.lastMessageBody||conv.lastMessage||'',messages,lastMessage:messages[messages.length-1]?.body||conv.lastMessage||'',_debug:{demo:true}});
  }
  let convRaw={}, msgRaw={}, convErr=null, msgErr=null;
  try{
    convRaw=await ghl('GET',`/conversations/${id}`);
  }catch(e){ convErr=e.message; }

  try{
    msgRaw=await ghl('GET',`/conversations/${id}/messages?limit=20`);
  }catch(e){ msgErr=e.message; }

  const conv=convRaw.conversation||convRaw;

  // GHL nests messages as msgRaw.messages.messages
  const msgContainer=msgRaw.messages||msgRaw;
  const rawMessages=Array.isArray(msgContainer)?msgContainer
    :(msgContainer.messages||msgRaw.data||[]);

  console.log('rawMessages type:', typeof rawMessages, Array.isArray(rawMessages), 'length:', rawMessages.length);
  if(rawMessages[0]) console.log('first msg keys:', Object.keys(rawMessages[0]));

  const messages=rawMessages
    .filter(m=>m&&typeof m==='object')
    .slice(-15)
    .map(m=>{
      // GHL email messages store body in meta.email or body or html
      var body=m.body||m.text||m.content||m.html||m.message
        ||(m.meta&&m.meta.email&&m.meta.email.body)
        ||(m.attachments&&m.attachments[0]&&m.attachments[0].url?'[Attachment]':'')
        ||'(no body)';
      // Strip HTML tags for readability
      body=body.replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim();
      var dir=(m.direction==='outbound'||m.type===1||m.type==='outbound')?'outbound':'inbound';
      return {
        id:m.id||'',
        direction:dir,
        body:body,
        type:m.type||m.messageType||m.contentType||'unknown',
        dateAdded:m.dateAdded||m.createdAt||'',
        from:dir==='outbound'?'You':conv.contactName||'Contact'
      };
    })
    .filter(m=>m.body&&m.body!=='(no body)');

  res.json({
    id,
    contactName:conv.contactName||conv.name||'Contact',
    contactId:conv.contactId||'',
    type:conv.type||'unknown',
    unreadCount:conv.unreadCount||0,
    lastMessageBody:conv.lastMessageBody||'',
    messages,
    lastMessage:messages[messages.length-1]?.body||conv.lastMessageBody||'',
    _debug:{convErr,msgErr,rawMessageCount:rawMessages.length,firstMsgKeys:rawMessages[0]?Object.keys(rawMessages[0]):[]}
  });
});

app.get('/api/comms',async(req,res)=>{
  try{
    if(DEMO_MODE){
      const convos=demoState(req,res).conversations||[];
      const unread=convos.filter(c=>(c.unreadCount||c.unread)>0);
      return res.json({total:unread.length,ghlUnread:unread.length,items:unread.map(c=>({id:c.id,label:`${c.contactName||'Contact'} (${c.unreadCount||c.unread} unread)`,sublabel:c.lastMessage||'',source:'demo',type:'unread',actionUrl:VAL_SIGNUP_URL}))});
    }
    const d=await ghl('GET',`/conversations/search?locationId=${GHL_LOC}&limit=50`);
    const convos=d.conversations||[];
    const unread=convos.filter(c=>c.unreadCount>0);
    res.json({
      total:unread.length,
      ghlUnread:unread.length,
      items:unread.map(c=>({
        id:c.id,
        label:`${c.contactName||'Contact'} (${c.unreadCount} unread)`,
        sublabel:c.lastMessage||'',
        source:'ghl',
        type:'unread',
        actionUrl:`https://app.gohighlevel.com/v2/location/${GHL_LOC}/conversations/${c.id}`
      }))
    });
  }catch(e){
    console.error('comms error:',e);
    res.json({total:0,ghlUnread:0,items:[],error:e.message});
  }
});

app.get('/api/feed',async(req,res)=>{
  try{
    const now=Date.now();
    const todayStart=new Date();todayStart.setHours(0,0,0,0);
    const todayEnd=new Date();todayEnd.setHours(23,59,59,999);

    const [convosRes, oppsRes, tasksRes, calRes] = await Promise.allSettled([
      ghl('GET',`/conversations/search?locationId=${GHL_LOC}&limit=30`),
      ghl('GET',`/opportunities/search?location_id=${GHL_LOC}&status=open&limit=50`),
      ghl('GET',`/tasks/search?locationId=${GHL_LOC}&limit=50`),
      (async()=>{
        let events=[];
        try{
          events.push(...await fetchGhlCalendarEvents(todayStart,todayEnd));
          events.push(...await fetchGoogleCalendarEvents(todayStart,todayEnd,25).catch(()=>[]));
        }catch(e){}
        return events;
      })()
    ]);

    const items=[];

    // Unread conversations
    const convos=convosRes.status==='fulfilled'?(convosRes.value.conversations||[]):[];
    convos.filter(c=>c.unreadCount>0).slice(0,5).forEach(c=>{
      items.push({
        id:c.id,
        text:`${c.contactName||'Contact'} — ${c.unreadCount} unread message${c.unreadCount>1?'s':''}`,
        type:'Comms',color:'green',
        time:new Date(c.dateUpdated).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'}),
        actionUrl:`https://app.gohighlevel.com/v2/location/${GHL_LOC}/conversations/${c.id}`
      });
    });

    // Stalled pipeline deals
    const opps=oppsRes.status==='fulfilled'?(oppsRes.value.opportunities||[]):[];
    opps.filter(o=>(now-new Date(o.lastStatusChangeAt||o.updatedAt).getTime())>7*24*60*60*1000).slice(0,3).forEach(o=>{
      const days=Math.floor((now-new Date(o.lastStatusChangeAt||o.updatedAt).getTime())/(24*60*60*1000));
      items.push({
        text:`${o.contact?.name||o.name} — pipeline stalled ${days}d`,
        type:'Pipeline',color:'amber',
        time:o.pipelineStage?.name||'Open',
        actionUrl:`https://app.gohighlevel.com/v2/location/${GHL_LOC}/opportunities/${o.id}`
      });
    });

    // Overdue tasks
    const tasks=tasksRes.status==='fulfilled'?(tasksRes.value.tasks||tasksRes.value||[]):[];
    const taskArr=Array.isArray(tasks)?tasks:(tasks.tasks||[]);
    taskArr.filter(t=>t.dueDate&&new Date(t.dueDate)<new Date()&&!t.completed).slice(0,3).forEach(t=>{
      items.push({
        text:`Overdue: ${t.title||t.name||'Task'}`,
        type:'Task',color:'red',
        time:new Date(t.dueDate).toLocaleDateString([],{month:'short',day:'numeric'})
      });
    });

    // Today's meetings
    const events=calRes.status==='fulfilled'?(Array.isArray(calRes.value)?calRes.value:[]):[];
    events.slice(0,3).forEach(e=>{
      const start=e.startTime||e.start?.dateTime||e.start?.date;
      items.push({
        text:`Meeting: ${e.title||e.summary||'Appointment'}`,
        type:'Meeting',color:'gold',
        time:start?new Date(start).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'}):''
      });
    });

    // Sort: comms first, then pipeline, tasks, meetings
    const order={Comms:0,Pipeline:1,Task:2,Meeting:3};
    items.sort((a,b)=>(order[a.type]||9)-(order[b.type]||9));

    // Fallback if nothing
    if(!items.length){
      items.push({text:'All clear — no urgent signals',type:'Status',color:'navy',time:new Date().toLocaleTimeString([],{hour:'numeric',minute:'2-digit'})});
    }

    res.json({feedItems:items,followups:convos.filter(c=>c.unreadCount>0).length});
  }catch(e){
    console.error('feed error:',e);
    res.json({feedItems:[{text:'Feed unavailable',type:'Error',color:'red',time:''}],followups:0});
  }
});

// ════════════════════════════════════════════════════════
// 1-2. CALENDAR TOOLS
// ════════════════════════════════════════════════════════

app.get('/api/ghl/calendar/events',async(req,res)=>{
  try{
    const {calendarId,userId,groupId,startTime,endTime}=req.query;
    if(!calendarId && !GHL_CALENDAR_IDS.length){
      const s=startTime?new Date(Number(startTime)):new Date();
      const e=endTime?new Date(Number(endTime)):(()=>{const d=new Date();d.setDate(d.getDate()+7);return d;})();
      return res.json({events:await fetchGhlCalendarEvents(s,e)});
    }
    let qs=`locationId=${GHL_LOC}`;
    qs+=`&calendarId=${calendarId||GHL_CALENDAR_IDS[0]||GHL_CALENDAR_ID}`;
    if(userId)qs+=`&userId=${userId}`;
    if(groupId)qs+=`&groupId=${groupId}`;
    if(startTime)qs+=`&startTime=${startTime}`;
    if(endTime)qs+=`&endTime=${endTime}`;
    res.json(await ghl('GET',`/calendars/events?${qs}`));
  }catch(e){res.status(500).json({error:e.message});}
});

app.get('/api/ghl/calendar/appointments/:id/notes',async(req,res)=>{
  try{res.json(await ghl('GET',`/calendars/appointments/${req.params.id}/notes`));}
  catch(e){res.status(500).json({error:e.message});}
});

// ════════════════════════════════════════════════════════
// 3-10. CONTACT TOOLS
// ════════════════════════════════════════════════════════

app.get('/api/ghl/contacts',async(req,res)=>{
  try{
    const {limit=20,query,sortBy,sortDirection}=req.query;
    let qs=`locationId=${GHL_LOC}&limit=${limit}`;
    if(query)qs+=`&query=${encodeURIComponent(query)}`;
    if(sortBy)qs+=`&sortBy=${sortBy}`;
    if(sortDirection)qs+=`&sortDirection=${sortDirection}`;
    res.json(await ghl('GET',`/contacts/?${qs}`));
  }catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/ghl/contacts',async(req,res)=>{
  try{res.json(await ghl('POST',`/contacts`,{...req.body,locationId:GHL_LOC}));}
  catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/val/contacts/create',async(req,res)=>{
  try{
    const body=req.body||{};
    const name=body.name||[body.firstName,body.lastName].filter(Boolean).join(' ')||body.email||'New contact';
    const parts=String(name).trim().split(/\s+/).filter(Boolean);
    const payload={
      locationId:GHL_LOC,
      firstName:body.firstName||parts[0]||name,
      lastName:body.lastName||parts.slice(1).join(' '),
      email:body.email||undefined,
      phone:body.phone||undefined,
      tags:['val_created_contact']
    };
    const data=await ghl('POST',`/contacts`,payload);
    res.json({ok:true,created:true,contact:data.contact||data});
  }catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/val/ghl/actions',async(req,res)=>{
  try{
    const result=await executeValGhlAction(req.body||{});
    res.json(result);
  }catch(e){res.status(400).json({ok:false,error:e.message});}
});

app.post('/api/val/ghl/action',async(req,res)=>{
  try{
    const result=await executeValGhlAction(req.body||{});
    res.json(result);
  }catch(e){res.status(400).json({ok:false,error:e.message});}
});

app.post('/api/val/leads/research',async(req,res)=>{
  try{
    const body=req.body||{};
    const company=String(body.company||body.companyName||body.organization||body.organizationName||'').trim();
    const location=String(body.location||body.cityState||'').trim();
    const contactId=String(body.contactId||'').trim();
    if(!company) return res.status(400).json({error:'Missing company name'});
    if(DEMO_MODE){
      const lead={...demoLeads({market:location||'United States',limit:1})[0],organizationName:company,location:location||'Demo Market'};
      const content=`company_payload:\nCompany Name: ${lead.organizationName}\nIndustry: ${lead.industry}\nPrimary Service: ${lead.primaryService}\nBusiness Model: B2B services\nLocation(s): ${lead.location}\nWebsite Status: active\n\ngoogle_raw:\n${lead.googleRaw}\n\ncompany_signals_raw:\n- Hiring activity: ${lead.hiringActivity}\n- Careers page: ${lead.careersPage}\n- Operational indicators: ${lead.operationalIndicators}\n\ncompany_news_raw:\n${lead.newsRaw}\n\nlinkedin_personal_url:\n${lead.linkedinPersonalUrl}\n\nlinkedin_company_url:\n${lead.linkedinCompanyUrl}`;
      return res.json({ok:true,company,location,content:withDemoCta(content),fields:parseLeadFieldOutputs(content),ghlUpdate:{updated:!!contactId,demo:true}});
    }
    const user=[
      'Research this potential business lead for GOALL using the GOALL lead intelligence standard.',
      'Company name: '+company,
      location?'City/state or market: '+location:'',
      body.website?'Known website: '+body.website:'',
      '',
      'Follow the required search process. Evaluate fit as a GOALL Agency business lead, especially employee count, hiring/growth signals, operational complexity, and reachable decision-makers. Return only the strict field outputs.'
    ].filter(Boolean).join('\n');
    const content=await callOpenAIWebResearch({system:GOALL_LEADS_SYSTEM_PROMPT,user,maxTokens:2600,temperature:0.1});
    if(!String(content||'').trim()) throw new Error('Lead search returned no content. Check OPENAI_KEY, model web-search support, and the requested organization name.');
    const fields=parseLeadFieldOutputs(content);
    let ghlUpdate={updated:false};
    if(contactId){
      ghlUpdate=await updateGhlLeadFields(contactId,fields).catch(e=>({updated:false,error:e.message}));
    }
    await saveMemoryItem({
      kind:'goall_lead_intelligence',
      summary:`Lead intelligence: ${company}${location?' - '+location:''}`,
      rawText:content,
      importance:3,
      metadata:{company,location,contactId,ghlUpdate}
    }).catch(()=>{});
    res.json({ok:true,company,location,content,fields,ghlUpdate});
  }catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/val/leads/discover',async(req,res)=>{
  try{
    if(DEMO_MODE){
      const discovered=demoLeadDiscovery(req.body||{});
      return res.json({...discovered,content:withDemoCta(leadPreviewText(discovered))});
    }
    const discovered=await withTimeout(
      discoverHbsLeadProspects(req.body||{}),
      GOALL_LEAD_DISCOVERY_TIMEOUT_MS,
      'lead scrape timed out before results returned'
    );
    const content=discovered.content||leadPreviewText(discovered);
    await saveMemoryItem({
      kind:'goall_prospect_discovery',
      summary:`Prospect discovery: ${discovered.criteria} in ${discovered.market}`,
      rawText:content,
      importance:3,
      metadata:{market:discovered.market,criteria:discovered.criteria,limit:discovered.report?.requestedViableLeads,report:discovered.report}
    }).catch(()=>{});
    res.json({...discovered,content});
  }catch(e){
    const fallback=leadDiscoveryErrorPayload(req.body||{},e);
    res.json(fallback);
  }
});

app.post('/api/val/leads/discover-create',async(req,res)=>{
  try{
    if(DEMO_MODE){
      const discovered=demoLeadDiscovery(req.body||{});
      return res.json({...discovered,...{created:discovered.leads,failed:[],skipped:[],content:withDemoCta(`Imported ${discovered.leads.length} demo leads to the demo CRM.\n\nTag applied: ${discovered.tag}\nPipeline stage: New Lead`)}});
    }
    const body=req.body||{};
    const discovered=await discoverHbsLeadProspects(body);
    const imported=await importApprovedHbsLeads(discovered);
    res.json({...discovered,...imported});
  }catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/val/leads/discover-preview',async(req,res)=>{
  try{
    if(DEMO_MODE){
      const discovered=demoLeadDiscovery(req.body||{});
      return res.json({...discovered,content:withDemoCta(leadPreviewText(discovered))});
    }
    const discovered=await withTimeout(
      discoverHbsLeadProspects(req.body||{}),
      GOALL_LEAD_DISCOVERY_TIMEOUT_MS,
      'lead scrape timed out before results returned'
    );
    res.json({...discovered,content:discovered.content||leadPreviewText(discovered)});
  }catch(e){
    const fallback=leadDiscoveryErrorPayload(req.body||{},e);
    res.json(fallback);
  }
});

app.post('/api/val/leads/import-approved',async(req,res)=>{
  try{
    const body=req.body||{};
    if(DEMO_MODE){
      const discovered=demoLeadDiscovery(body);
      const leads=Array.isArray(body.leads)&&body.leads.length?body.leads:discovered.leads;
      return res.json({...discovered,leads,created:leads,failed:[],skipped:[],content:withDemoCta(`Imported ${leads.length} approved demo lead${leads.length===1?'':'s'} to the demo CRM.\n\nTag applied: ${discovered.tag}\nSource: LimitLess Leads\nPipeline stage: New Lead`)});
    }
    const discovered={
      market:String(body.market||'United States'),
      criteria:String(body.criteria||'Approved GOALL lead import'),
      organizationType:String(body.organizationType||'businesses'),
      employeeMinimum:donorValue(body.employeeMinimum)||300,
      tag:normalizeLeadTag(body.tag||body.organizationType),
      scraped:body.scraped||body.outscraper||{},
      leads:Array.isArray(body.leads)?body.leads:[],
      leadProfile:body.leadProfile||body.searchPlan?.leadProfile||'',
      searchPlan:body.searchPlan||null,
      report:body.report||null
    };
    if(!discovered.leads.length) throw new Error('No approved leads were provided for import.');
    const imported=await importApprovedHbsLeads(discovered);
    res.json({...discovered,...imported});
  }catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/val/partners/discover-preview',async(req,res)=>{
  try{
    const body=req.body||{};
    const request={
      ...body,
      leadProfile:'goall',
      organizationType:String(body.partnerType||body.organizationType||'strategic distribution partners'),
      criteria:String(body.criteria||`Find ${body.partnerType||'strategic partner organizations'} that can distribute, recommend, introduce, or sell GOALL. Prioritize ${GOALL_PRIORITY_ASSOCIATIONS.join(', ')} and similar organizations. Use public information, prefer sources updated in the last 12 months, and find at least two supporting source URLs whenever possible. For associations capture industry served, membership size, geographic reach, executive leadership, membership/partnership/events directors, conference details, vendor and sponsor opportunities. For agencies capture agency type, employee/revenue estimates, states licensed, decision makers, and benefits/life/commercial insurance evidence.`),
      employeeMinimum:1,
      market:String(body.market||'United States'),
      limit:Math.min(Math.max(Number(body.limit)||12,1),100),
      fastSearch:false,
      rocketReachMode:body.rocketReachMode||'defer'
    };
    const discovered=DEMO_MODE?demoLeadDiscovery(request):await withTimeout(discoverHbsLeadProspects(request),GOALL_LEAD_DISCOVERY_TIMEOUT_MS,'partner scrape timed out before results returned');
    const leads=(discovered.leads||[]).map(lead=>scorePartnerFit({...lead,partnerType:body.partnerType||lead.partnerType}));
    const result={...discovered,ok:true,prospectingMode:'partners',leadProfile:'partners',partnerTypes:GOALL_PARTNER_TYPES,leads,crmDestination:{pipeline:GHL_PARTNER_PIPELINE_NAME,stage:GHL_PARTNER_STAGE_NAME},researchStandard:{publicOnly:true,preferredFreshnessMonths:12,supportingSourcesPreferred:2}};
    result.content=partnerPreviewText(result);
    res.json(result);
  }catch(e){res.json({ok:false,prospectingMode:'partners',leads:[],error:e.message,content:`Partner scrape could not complete.\n\n${e.message}`});}
});

app.post('/api/val/partners/import-approved',async(req,res)=>{
  try{
    if(DEMO_MODE){
      const leads=(req.body?.leads||[]).map(scorePartnerFit);
      return res.json({ok:true,created:leads,failed:[],content:withDemoCta(`Pushed ${leads.length} approved demo strategic partners to GOALL Strategic Partners / New Limitless Lead Added.`)});
    }
    res.json(await importApprovedPartnerLeads(req.body||{}));
  }catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/val/leads/rocketreach-enrich',async(req,res)=>{
  try{
    const body=req.body||{};
    const leads=Array.isArray(body.leads)?body.leads:[];
    if(!leads.length) throw new Error('No leads were provided for Level 3 verification.');
    if(DEMO_MODE){
      const enriched=leads.map((p,i)=>({...p,email:p.email||`decisionmaker${i+1}@example.com`,decisionMakerName:p.decisionMakerName||['Dana Holt','Marcus Chen','Renee Wallace'][i%3],decisionMakerTitle:p.decisionMakerTitle||'Operations Leader',rocketReachStatus:'verified demo email'}));
      const discovered={...demoLeadDiscovery(body),leads:enriched,rocketReachMode:'review'};
      return res.json({...discovered,content:withDemoCta(leadPreviewText(discovered))});
    }
    const enriched=await mapWithConcurrency(leads,1,p=>enrichProspect(p,{rocketReachMode:'force'}));
    const discovered={
      ok:true,
      market:String(body.market||'United States'),
      criteria:String(body.criteria||'Level 3 verification'),
      organizationType:String(body.organizationType||'businesses'),
      employeeMinimum:donorValue(body.employeeMinimum)||300,
      tag:normalizeLeadTag(body.tag||body.organizationType),
      scraped:body.scraped||body.outscraper||{},
      rocketReachMode:'review',
      leads:enriched
    };
    res.json({...discovered,content:leadPreviewText(discovered)});
  }catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/val/leads/enrich-current',async(req,res)=>{
  try{
    const body=req.body||{};
    if(DEMO_MODE){
      const leads=demoLeads({limit:4,market:'Demo CRM'}).map((l,i)=>({name:l.organizationName,contactName:l.decisionMakerName,email:l.email,phone:l.phone,website:l.website,decisionMakerName:l.decisionMakerName,confidence:l.confidence}));
      const content=withDemoCta(leads.map((l,i)=>`${i+1}. ${l.name}\n   Decision maker: ${l.decisionMakerName}\n   Email: ${l.email}\n   Phone: ${l.phone}\n   Status: verified demo data`).join('\n\n'));
      return res.json({ok:true,count:leads.length,leads,content,demo:true});
    }
    const exclude=(Array.isArray(body.exclude)?body.exclude:['aric','jessa']).map(v=>String(v).toLowerCase());
    const limit=leadLimitValue(body.limit);
    const d=await ghl('GET',`/opportunities/search?location_id=${GHL_LOC}&status=open&limit=100`);
    const leads=(d.opportunities||[])
      .map(leadContactSnapshot)
      .filter(l=>l.name && !exclude.some(x=>String(l.name+' '+l.contactName).toLowerCase().includes(x)))
      .slice(0,limit);
    if(!leads.length) return res.status(404).json({error:'No current GHL opportunities found to enrich.'});
    const system=[
      GOALL_LEADS_SYSTEM_PROMPT,
      'Current-lead enrichment mode: verify existing GHL lead data for business lead outreach.',
      'For each existing lead, verify or flag the best public phone, email/contact route, and actual likely decision-maker. Do not invent direct emails or phone numbers. If only a general contact channel is public, say that.',
      'Return a compact audit, grouped by lead. No preamble.'
    ].join('\n\n');
    const user=[
      'Audit these current GOALL business leads.',
      'Goal: check whether phone number, email/contact route, actual decision-maker, employee count, growth signal, workforce signal, and first-call angle look correct.',
      'Exclude internal test contacts when obvious. Flag unclear or weak data.',
      '',
      JSON.stringify(leads,null,2),
      '',
      'For each lead return:',
      'Lead:',
      'Current GHL phone:',
      'Verified public phone:',
      'Current GHL email:',
      'Verified public email/contact route:',
      'Likely decision-maker:',
      'Decision-maker title:',
      'Decision-maker LinkedIn if public:',
      'Estimated employee count:',
      'Employee count confidence:',
      'Growth signals:',
      'Leadership signals:',
      'Workforce or hiring signals:',
      'Engagement/activity signals:',
      'Lead Intelligence Summary:',
      'Recommended First Call Angle:',
      'What needs correction:',
      'Missing data:',
      'Confidence:'
    ].join('\n');
    const content=await callOpenAIWebResearch({system,user,maxTokens:5000,temperature:0.15});
    if(!String(content||'').trim()) throw new Error('Current lead enrichment returned no content. Check OPENAI_KEY and whether the selected model supports web search.');
    await saveMemoryItem({
      kind:'goall_current_lead_enrichment',
      summary:`Enriched ${leads.length} current GOALL leads`,
      rawText:content,
      importance:3,
      metadata:{leadCount:leads.length,leads}
    }).catch(()=>{});
    res.json({ok:true,count:leads.length,leads,content});
  }catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/ghl/contacts/upsert',async(req,res)=>{
  try{res.json(await ghl('POST',`/contacts/upsert`,req.body));}
  catch(e){res.status(500).json({error:e.message});}
});

app.get('/api/ghl/contacts/:id',async(req,res)=>{
  try{res.json(await ghl('GET',`/contacts/${req.params.id}`));}
  catch(e){res.status(500).json({error:e.message});}
});

app.get('/api/ghl/contacts/:id/notes',async(req,res)=>{
  try{res.json(await ghl('GET',`/contacts/${req.params.id}/notes`));}
  catch(e){res.status(500).json({error:e.message});}
});

app.put('/api/ghl/contacts/:id',async(req,res)=>{
  try{res.json(await ghl('PUT',`/contacts/${req.params.id}`,req.body));}
  catch(e){res.status(500).json({error:e.message});}
});

app.get('/api/ghl/contacts/:id/tasks',async(req,res)=>{
  try{res.json(await ghl('GET',`/contacts/${req.params.id}/tasks`));}
  catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/ghl/contacts/:id/tasks',async(req,res)=>{
  try{res.json(await ghl('POST',`/contacts/${req.params.id}/tasks`,req.body));}
  catch(e){res.status(500).json({error:e.message});}
});

app.get('/api/ghl/contacts/search',async(req,res)=>{
  try{
    const q=req.query.q||'';
    const d=await ghl('GET',`/contacts/?locationId=${GHL_LOC}&query=${encodeURIComponent(q)}&limit=5`);
    res.json({contacts:(d.contacts||[]).map(c=>({id:c.id,name:c.contactName||c.name||c.firstName+' '+c.lastName,email:c.email,phone:c.phone}))});
  }catch(e){res.status(500).json({error:e.message});}
});


app.post('/api/ghl/contacts/:id/tags',async(req,res)=>{
  try{res.json(await ghl('POST',`/contacts/${req.params.id}/tags`,req.body));}
  catch(e){res.status(500).json({error:e.message});}
});

app.delete('/api/ghl/contacts/:id/tags',async(req,res)=>{
  try{res.json(await ghl('DELETE',`/contacts/${req.params.id}/tags`,req.body));}
  catch(e){res.status(500).json({error:e.message});}
});

// ════════════════════════════════════════════════════════
// 11-13. CONVERSATION TOOLS
// ════════════════════════════════════════════════════════

app.get('/api/ghl/conversations',async(req,res)=>{
  try{
    const {limit=20,query,status}=req.query;
    let qs=`locationId=${GHL_LOC}&limit=${limit}`;
    if(query)qs+=`&query=${encodeURIComponent(query)}`;
    if(status)qs+=`&status=${status}`;
    res.json(await ghl('GET',`/conversations/search?${qs}`));
  }catch(e){res.status(500).json({error:e.message});}
});

app.get('/api/ghl/conversations/:id/messages',async(req,res)=>{
  try{res.json(await ghl('GET',`/conversations/${req.params.id}/messages`));}
  catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/ghl/conversations/:id/messages',async(req,res)=>{
  try{res.json(await ghl('POST',`/conversations/messages`,{...req.body,conversationId:req.params.id}));}
  catch(e){res.status(500).json({error:e.message});}
});

// ════════════════════════════════════════════════════════
// 14-15. LOCATION TOOLS
// ════════════════════════════════════════════════════════

app.get('/api/ghl/location',async(req,res)=>{
  try{res.json(await ghl('GET',`/locations/${GHL_LOC}`));}
  catch(e){res.status(500).json({error:e.message});}
});

app.get('/api/ghl/location/custom-fields',async(req,res)=>{
  try{res.json(await ghl('GET',`/locations/${GHL_LOC}/customFields`));}
  catch(e){res.status(500).json({error:e.message});}
});

// ════════════════════════════════════════════════════════
// 16-19. OPPORTUNITY TOOLS
// ════════════════════════════════════════════════════════

app.get('/api/ghl/opportunities',async(req,res)=>{
  try{
    const {limit=20,query,status,pipelineId,stageId}=req.query;
    let qs=`location_id=${GHL_LOC}&limit=${limit}`;
    if(query)qs+=`&query=${encodeURIComponent(query)}`;
    if(status)qs+=`&status=${status}`;
    if(pipelineId)qs+=`&pipeline_id=${pipelineId}`;
    if(stageId)qs+=`&pipeline_stage_id=${stageId}`;
    res.json(await ghl('GET',`/opportunities/search?${qs}`));
  }catch(e){res.status(500).json({error:e.message});}
});

app.get('/api/ghl/pipelines',async(req,res)=>{
  try{res.json(await ghl('GET',`/opportunities/pipelines?locationId=${GHL_LOC}`));}
  catch(e){res.status(500).json({error:e.message});}
});

app.get('/api/ghl/opportunities/:id',async(req,res)=>{
  try{res.json(await ghl('GET',`/opportunities/${req.params.id}`));}
  catch(e){res.status(500).json({error:e.message});}
});

app.put('/api/ghl/opportunities/:id',async(req,res)=>{
  try{res.json(await ghl('PUT',`/opportunities/${req.params.id}`,req.body));}
  catch(e){res.status(500).json({error:e.message});}
});

// ════════════════════════════════════════════════════════
// 20-21. PAYMENT TOOLS
// ════════════════════════════════════════════════════════

app.get('/api/ghl/payments/orders/:id',async(req,res)=>{
  try{res.json(await ghl('GET',`/payments/orders/${req.params.id}?locationId=${GHL_LOC}`));}
  catch(e){res.status(500).json({error:e.message});}
});

app.get('/api/ghl/payments/transactions',async(req,res)=>{
  try{
    const {limit=20,startAt,endAt}=req.query;
    let qs=`locationId=${GHL_LOC}&limit=${limit}`;
    if(startAt)qs+=`&startAt=${startAt}`;
    if(endAt)qs+=`&endAt=${endAt}`;
    res.json(await ghl('GET',`/payments/transactions?${qs}`));
  }catch(e){res.status(500).json({error:e.message});}
});

// ════════════════════════════════════════════════════════
// 22-28. BLOG TOOLS
// ════════════════════════════════════════════════════════

app.get('/api/ghl/blogs',async(req,res)=>{
  try{res.json(await ghl('GET',`/blogs/?locationId=${GHL_LOC}`));}
  catch(e){res.status(500).json({error:e.message});}
});

app.get('/api/ghl/blogs/check-slug',async(req,res)=>{
  try{
    const {urlSlug,blogId,postId}=req.query;
    let qs=`locationId=${GHL_LOC}&urlSlug=${encodeURIComponent(urlSlug)}&blogId=${blogId}`;
    if(postId)qs+=`&postId=${postId}`;
    res.json(await ghl('GET',`/blogs/posts/url-slug-exists?${qs}`));
  }catch(e){res.status(500).json({error:e.message});}
});

app.get('/api/ghl/blogs/authors',async(req,res)=>{
  try{res.json(await ghl('GET',`/blogs/authors?locationId=${GHL_LOC}`));}
  catch(e){res.status(500).json({error:e.message});}
});

app.get('/api/ghl/blogs/categories',async(req,res)=>{
  try{res.json(await ghl('GET',`/blogs/categories?locationId=${GHL_LOC}`));}
  catch(e){res.status(500).json({error:e.message});}
});

app.get('/api/ghl/blogs/:blogId/posts',async(req,res)=>{
  try{
    const {limit=20,skip=0}=req.query;
    res.json(await ghl('GET',`/blogs/${req.params.blogId}/posts?locationId=${GHL_LOC}&limit=${limit}&skip=${skip}`));
  }catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/ghl/blogs/:blogId/posts',async(req,res)=>{
  try{res.json(await ghl('POST',`/blogs/${req.params.blogId}/posts`,{...req.body,locationId:GHL_LOC}));}
  catch(e){res.status(500).json({error:e.message});}
});

app.put('/api/ghl/blogs/:blogId/posts/:postId',async(req,res)=>{
  try{res.json(await ghl('PUT',`/blogs/${req.params.blogId}/posts/${req.params.postId}`,req.body));}
  catch(e){res.status(500).json({error:e.message});}
});

// ════════════════════════════════════════════════════════
// 29-30. EMAIL TOOLS
// ════════════════════════════════════════════════════════

app.get('/api/ghl/emails/templates',async(req,res)=>{
  try{
    const {limit=20,skip=0}=req.query;
    res.json(await ghl('GET',`/emails/builder?locationId=${GHL_LOC}&limit=${limit}&skip=${skip}`));
  }catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/ghl/emails/templates',async(req,res)=>{
  try{res.json(await ghl('POST',`/emails/builder`,{...req.body,locationId:GHL_LOC}));}
  catch(e){res.status(500).json({error:e.message});}
});

// ════════════════════════════════════════════════════════
// 31-36. SOCIAL MEDIA TOOLS
// ════════════════════════════════════════════════════════

app.get('/api/ghl/social/accounts',async(req,res)=>{
  try{res.json(await ghl('GET',`/social-media-posting/oauth/${GHL_LOC}/accounts`));}
  catch(e){res.status(500).json({error:e.message});}
});

app.get('/api/ghl/social/statistics',async(req,res)=>{
  try{
    const {startDate,endDate,accountIds}=req.query;
    let qs=`locationId=${GHL_LOC}`;
    if(startDate)qs+=`&startDate=${startDate}`;
    if(endDate)qs+=`&endDate=${endDate}`;
    if(accountIds)qs+=`&accountIds=${accountIds}`;
    res.json(await ghl('GET',`/social-media-posting/statistics?${qs}`));
  }catch(e){res.status(500).json({error:e.message});}
});

app.get('/api/ghl/social/posts',async(req,res)=>{
  try{
    const {limit=20,skip=0,status}=req.query;
    let qs=`limit=${limit}&skip=${skip}`;
    if(status)qs+=`&status=${status}`;
    res.json(await ghl('GET',`/social-media-posting/${GHL_LOC}/posts?${qs}`));
  }catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/ghl/social/posts',async(req,res)=>{
  try{res.json(await ghl('POST',`/social-media-posting/${GHL_LOC}/posts`,req.body));}
  catch(e){res.status(500).json({error:e.message});}
});

app.get('/api/ghl/social/posts/:id',async(req,res)=>{
  try{res.json(await ghl('GET',`/social-media-posting/${GHL_LOC}/posts/${req.params.id}`));}
  catch(e){res.status(500).json({error:e.message});}
});

app.put('/api/ghl/social/posts/:id',async(req,res)=>{
  try{res.json(await ghl('PUT',`/social-media-posting/${GHL_LOC}/posts/${req.params.id}`,req.body));}
  catch(e){res.status(500).json({error:e.message});}
});

// ════════════════════════════════════════════════════════
// VAL DURABLE STORE — tasks, memory, transcripts, files
// ════════════════════════════════════════════════════════
function readTasks(){ return readJson(TASKS_FILE,[]); }
function writeTasks(tasks){ writeJson(TASKS_FILE,tasks); }
function rowToTask(row){
  return {id:row.id,title:row.title,contactName:row.contact_name||'',dueDate:row.due_date?row.due_date.toISOString():null,notes:row.notes||'',details:row.details||[],completed:!!row.completed,completedAt:row.completed_at?row.completed_at.toISOString():null,completedBy:row.completed_by||'',createdAt:row.created_at?row.created_at.toISOString():new Date().toISOString()};
}
async function loadTasks(){
  if(DEMO_MODE) return cloneDemo(requestContext.getStore()?.demoState?.tasks || []);
  await valDbReady;
  if(pgPool){
    const r=await dbQuery('select * from val_tasks where user_id=$1 order by completed asc, due_date asc nulls last, created_at desc',[VAL_USER_ID]);
    return r.rows.map(rowToTask);
  }
  return readTasks();
}
async function saveTask(task){
  task={...task};
  task.title=String(task.title||'Untitled task').trim()||'Untitled task';
  task.contactName=task.contactName||'';
  if(!task.dueDate&&!task.completed) task.dueDate=new Date(Date.now()+24*60*60*1000).toISOString();
  if(DEMO_MODE){
    const state=requestContext.getStore()?.demoState;
    if(state){
      const clean={...task,id:task.id||uuid('demo-task'),title:String(task.title||'Untitled task').trim()||'Untitled task',createdAt:task.createdAt||new Date().toISOString()};
      const idx=state.tasks.findIndex(t=>t.id===clean.id);
      if(idx>=0) state.tasks[idx]=clean; else state.tasks.push(clean);
    }
    return;
  }
  await valDbReady;
  if(pgPool){
    if(!task.completed){
      const dupe=await dbQuery('select id,details from val_tasks where user_id=$1 and completed=false and lower(title)=lower($2) and lower(coalesce(contact_name,\'\'))=lower($3) limit 1',[VAL_USER_ID,task.title,task.contactName]);
      if(dupe.rows[0]&&dupe.rows[0].id!==task.id){
        task.id=dupe.rows[0].id;
        const existingDetails=Array.isArray(dupe.rows[0].details)?dupe.rows[0].details:[];
        task.details=existingDetails.concat(task.details||[]);
      }
    }
    await dbQuery(`
      insert into val_tasks (id,user_id,title,contact_name,due_date,notes,details,completed,completed_at,completed_by,created_at,updated_at)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,coalesce($11::timestamptz,now()),now())
      on conflict (id) do update set title=excluded.title, contact_name=excluded.contact_name, due_date=excluded.due_date, notes=excluded.notes, details=excluded.details, completed=excluded.completed, completed_at=excluded.completed_at, completed_by=excluded.completed_by, updated_at=now()
    `,[task.id,VAL_USER_ID,task.title||'Untitled task',task.contactName||'',task.dueDate||null,task.notes||'',JSON.stringify(task.details||[]),!!task.completed,task.completedAt||null,task.completedBy||'',task.createdAt||null]);
    return;
  }
  const tasks=readTasks();
  if(!task.completed){
    const dupe=tasks.find(t=>t&&t.id!==task.id&&!t.completed&&String(t.title||'').toLowerCase()===String(task.title||'').toLowerCase()&&String(t.contactName||'').toLowerCase()===String(task.contactName||'').toLowerCase());
    if(dupe){
      task.id=dupe.id;
      task.details=(Array.isArray(dupe.details)?dupe.details:[]).concat(task.details||[]);
    }
  }
  const idx=tasks.findIndex(t=>t.id===task.id);
  if(idx>=0)tasks[idx]=task; else tasks.push(task);
  writeTasks(tasks);
}
async function replaceTasks(tasks){
  if(DEMO_MODE){
    const state=requestContext.getStore()?.demoState;
    if(state) state.tasks=cloneDemo(tasks);
    return;
  }
  await valDbReady;
  if(pgPool){
    for(const task of tasks) await saveTask(task);
    return;
  }
  const existing=readTasks();
  const byId={};
  existing.concat(tasks).forEach(t=>{if(t&&t.id)byId[t.id]=t;});
  writeTasks(Object.keys(byId).map(id=>byId[id]));
}
async function deleteTask(id){
  if(DEMO_MODE){
    const state=requestContext.getStore()?.demoState;
    if(state) state.tasks=(state.tasks||[]).filter(t=>t.id!==id);
    return;
  }
  await valDbReady;
  if(pgPool){ await dbQuery('delete from val_tasks where user_id=$1 and id=$2',[VAL_USER_ID,id]); return; }
  writeTasks(readTasks().filter(t=>t.id!==id));
}
function cleanAutoTaskTitle(line){
  return String(line||'')
    .replace(/<[^>]*>/g,'')
    .replace(/^\s*(?:[-*•]|\d+[\.)])\s*/,'')
    .replace(/^\s*(?:to[- ]?do list|do now|next|later|blocked|task|tasks|todo|to-do|next step|action item|recommendation|priority)\s*[:\-]\s*/i,'')
    .replace(/\*\*/g,'')
    .replace(/\s+/g,' ')
    .trim();
}
function splitAutoTaskText(text){
  const source=String(text||'');
  const match=source.match(/(?:^|\n)\s*(?:#{1,4}\s*)?(?:to[- ]?do list|to dos|todos|tasks|next steps|action items)\s*:?\s*\n([\s\S]*?)(?=\n\s*(?:#{1,4}\s*)?(?:done|completed|context|notes|why this matters|summary|chapter notes|draft|response|analysis)\s*:?\s*\n|$)/i);
  const scoped=match&&match[1]?match[1]:source;
  const normalized=scoped
    .replace(/\r/g,'\n')
    .replace(/(?:^|\s)(\d+[\.)])\s+/g,'\n$1 ')
    .replace(/\s+[•*]\s+/g,'\n- ')
    .replace(/\s+-\s+(?=[A-Z])/g,'\n- ');
  const lines=[];
  for(const raw of normalized.split(/\n+/)){
    const line=String(raw||'').trim();
    if(!line) continue;
    const cleaned=cleanAutoTaskTitle(line);
    if(!cleaned) continue;
    const semiParts=cleaned.split(/\s*;\s+/).map(cleanAutoTaskTitle).filter(Boolean);
    if(semiParts.length>1) lines.push(...semiParts);
    else lines.push(cleaned);
  }
  return lines;
}
function extractAutoTasksFromValText(text){
  const lines=splitAutoTaskText(text);
  const actionVerb=/\b(send|draft|call|email|schedule|review|prep|prepare|create|update|follow|follow up|check|finish|decide|delegate|book|write|ask|confirm|share|add|research|organize|clean|summarize|reach out|upload|read|revise|rewrite|edit|map|align|cut|move|tighten|polish)\b/i;
  const candidates=lines.filter(line=>{
    if(line.length<8||line.length>180) return false;
    if(/[?]$/.test(line)) return false;
    if(/^(yes|no|done|source|rewrite|readable characters|google drive|google docs|here|sure|okay|because|why this matters)$/i.test(line)) return false;
    return actionVerb.test(line) || /^[A-Z][^:]{2,70}:\s+\S/.test(line);
  }).map(line=>line.replace(/^[A-Z][^:]{2,70}:\s*/,'').trim());
  const seen=new Set();
  return candidates.filter(line=>{
    const key=line.toLowerCase();
    if(seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0,8);
}
async function persistAutoTasksFromValResponse({content,userQuery='',action='chat',source='val_response'}={}){
  if(!isBookEditorProject()) return [];
  const existingOpen=(await loadTasks()).filter(t=>!t.completed).length;
  if(existingOpen>=80) return [];
  const titles=extractAutoTasksFromValText(content);
  if(!titles.length) return [];
  const created=[];
  for(const title of titles){
    const task={
      id:uuid('task'),
      title,
      contactName:'',
      dueDate:null,
      notes:[
        `Auto-created from VAL ${action} response.`,
        userQuery?`User request: ${userQuery}`:'',
        `Context:\n${String(content||'').slice(0,1800)}`
      ].filter(Boolean).join('\n\n'),
      details:[{
        text:`Created from VAL response. Source: ${source}. ${userQuery?`User request: ${userQuery}`:''}`.trim(),
        ts:new Date().toISOString()
      }],
      completed:false,
      createdAt:new Date().toISOString()
    };
    await saveTask(task);
    await saveMemoryItem({
      kind:'task_backup',
      summary:`Task backup: ${title}`,
      rawText:JSON.stringify({task,source,action,userQuery}).slice(0,8000),
      importance:3,
      metadata:{source:'auto_task_capture',action,userQuery,title}
    }).catch(()=>{});
    created.push(task);
  }
  return created;
}
app.get('/api/val/tasks',async(req,res)=>{try{res.json(await loadTasks());}catch(e){res.status(500).json({error:e.message});}});
app.post('/api/val/tasks',async(req,res)=>{try{const task=req.body;if(!task||!task.id)return res.status(400).json({error:'Missing task id'});await saveTask(task);res.json({ok:true,task});}catch(e){res.status(500).json({error:e.message});}});
app.put('/api/val/tasks',async(req,res)=>{try{if(!Array.isArray(req.body))return res.status(400).json({error:'Expected array'});await replaceTasks(req.body);res.json({ok:true,count:req.body.length});}catch(e){res.status(500).json({error:e.message});}});
app.delete('/api/val/tasks/:id',async(req,res)=>{try{await deleteTask(req.params.id);res.json({ok:true});}catch(e){res.status(500).json({error:e.message});}});

const MEETING_RECAP_TEMPLATE_KEY='meeting_recap';
const DEFAULT_MEETING_RECAP_TEMPLATE={
  templateKey:MEETING_RECAP_TEMPLATE_KEY,
  name:'Meeting Recap Template',
  subjectTemplate:'Recap: {{meeting_title}}',
  htmlTemplate:[
    '<p>Hi {{recipient_first_name}},</p>',
    '<p>Thank you for the conversation. Here is the recap from <strong>{{meeting_title}}</strong>.</p>',
    '<h3>Executive summary</h3>',
    '<p>{{executive_summary}}</p>',
    '<h3>Key decisions</h3>',
    '<ul>{{key_decisions_html}}</ul>',
    '<h3>Open questions</h3>',
    '<ul>{{open_questions_html}}</ul>',
    '<h3>Next steps</h3>',
    '<ul>{{tasks_html}}</ul>',
    '<p>Best,</p>'
  ].join('\n'),
  textTemplate:[
    'Hi {{recipient_first_name}},',
    '',
    'Thank you for the conversation. Here is the recap from {{meeting_title}}.',
    '',
    'Executive summary:',
    '{{executive_summary}}',
    '',
    'Key decisions:',
    '{{key_decisions_text}}',
    '',
    'Open questions:',
    '{{open_questions_text}}',
    '',
    'Next steps:',
    '{{tasks_text}}',
    '',
    'Best,'
  ].join('\n')
};
function templatePgRow(row){
  return {id:row.id,userId:row.user_id,tenantId:row.tenant_id,templateKey:row.template_key,name:row.name,subjectTemplate:row.subject_template||'',htmlTemplate:row.html_template||'',textTemplate:row.text_template||'',isActive:row.is_active!==false,createdAt:row.created_at?row.created_at.toISOString():new Date().toISOString(),updatedAt:row.updated_at?row.updated_at.toISOString():new Date().toISOString()};
}
function systemTemplate(key){
  if(key===MEETING_RECAP_TEMPLATE_KEY)return {...DEFAULT_MEETING_RECAP_TEMPLATE,id:'system_'+key,userId:currentUserId(),tenantId:tenantId(),isActive:true,systemDefault:true,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
  return null;
}
async function getActiveTemplate(key){
  await valDbReady;
  if(pgPool){
    const r=await dbQuery('select * from val_templates where tenant_id=$1 and user_id=$2 and template_key=$3 and is_active=true order by updated_at desc limit 1',[tenantId(),currentUserId(),key]);
    return r.rows[0]?templatePgRow(r.rows[0]):systemTemplate(key);
  }
  const row=(valStore().templates||[]).filter(t=>t.tenantId===tenantId()&&t.userId===currentUserId()&&t.templateKey===key&&t.isActive!==false).sort((a,b)=>new Date(b.updatedAt||0)-new Date(a.updatedAt||0))[0];
  return row||systemTemplate(key);
}
async function saveTemplate(key,payload={}){
  const base=systemTemplate(key);
  if(!base)throw new Error('Unknown template key');
  const template={id:payload.id||uuid('tmpl'),userId:currentUserId(),tenantId:tenantId(),templateKey:key,name:payload.name||base.name,subjectTemplate:String(payload.subjectTemplate??payload.subject_template??base.subjectTemplate),htmlTemplate:String(payload.htmlTemplate??payload.html_template??base.htmlTemplate),textTemplate:String(payload.textTemplate??payload.text_template??base.textTemplate),isActive:payload.isActive!==false,createdAt:payload.createdAt||new Date().toISOString(),updatedAt:new Date().toISOString()};
  if(pgPool){
    const r=await dbQuery(`
      insert into val_templates (id,user_id,tenant_id,template_key,name,subject_template,html_template,text_template,is_active,created_at,updated_at)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,coalesce($10::timestamptz,now()),now())
      on conflict (tenant_id,user_id,template_key) do update set name=excluded.name,subject_template=excluded.subject_template,html_template=excluded.html_template,text_template=excluded.text_template,is_active=excluded.is_active,updated_at=now()
      returning *
    `,[template.id,template.userId,template.tenantId,template.templateKey,template.name,template.subjectTemplate,template.htmlTemplate,template.textTemplate,template.isActive,template.createdAt]);
    return templatePgRow(r.rows[0]);
  }
  const store=valStore();store.templates=store.templates||[];
  const idx=store.templates.findIndex(t=>t.tenantId===template.tenantId&&t.userId===template.userId&&t.templateKey===template.templateKey);
  if(idx>=0)store.templates[idx]={...store.templates[idx],...template}; else store.templates.unshift(template);
  saveValStore(store);return template;
}
function renderTemplateString(source,vars){
  return String(source||'').replace(/{{\s*([a-zA-Z0-9_]+)\s*}}/g,(_,key)=>String(vars[key]??''));
}
function escapeHtml(value){
  return String(value==null?'':value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function htmlList(items){
  const list=(Array.isArray(items)?items:[]).map(x=>String(typeof x==='string'?x:x?.title||x?.text||x?.taskTitle||'').trim()).filter(Boolean);
  return list.length?list.map(x=>`<li>${escapeHtml(x)}</li>`).join('\n'):'<li>None captured.</li>';
}
function textList(items){
  const list=(Array.isArray(items)?items:[]).map(x=>String(typeof x==='string'?x:x?.title||x?.text||x?.taskTitle||'').trim()).filter(Boolean);
  return list.length?list.map(x=>`- ${x}`).join('\n'):'- None captured.';
}
function firstName(name){return String(name||'there').trim().split(/\s+/)[0]||'there';}
async function renderMeetingRecapTemplate({transcriptId,title,summary,participants,tasks,sourceQuote}){
  const template=await getActiveTemplate(MEETING_RECAP_TEMPLATE_KEY);
  const recipient=(participants||[]).find(p=>!isOwnerRelationship({name:p.matchedContactName||p.speakerNameRaw,email:p.matchedEmail||''}))||participants?.[0]||{};
  const vars={
    meeting_title:title||'Meeting',
    transcript_id:transcriptId||'',
    recipient_name:recipient.matchedContactName||recipient.speakerNameRaw||'there',
    recipient_first_name:firstName(recipient.matchedContactName||recipient.speakerNameRaw),
    executive_summary:summary?.executiveSummary||summary?.summary||'Summary pending.',
    client_summary:summary?.clientSummary||'',
    internal_notes:summary?.internalNotes||'',
    key_decisions_html:htmlList(summary?.keyDecisions),
    key_decisions_text:textList(summary?.keyDecisions),
    open_questions_html:htmlList(summary?.openQuestions),
    open_questions_text:textList(summary?.openQuestions),
    relationship_updates_html:htmlList(summary?.relationshipUpdates),
    relationship_updates_text:textList(summary?.relationshipUpdates),
    tasks_html:htmlList(tasks),
    tasks_text:textList(tasks),
    source_quote:sourceQuote||''
  };
  return {template,subject:renderTemplateString(template.subjectTemplate,vars).trim()||`Recap: ${title||'Meeting'}`,htmlBody:renderTemplateString(template.htmlTemplate,vars),textBody:renderTemplateString(template.textTemplate,vars),vars};
}
async function saveMeetingRecapDraft({transcriptId,title,summary,participants,tasks,transcriptText}){
  const rendered=await renderMeetingRecapTemplate({transcriptId,title,summary,participants,tasks,sourceQuote:transcriptSupportingQuote(transcriptText,'')});
  const existing=(await listDrafts()).find(d=>d.draftType==='meeting_recap'&&d.sourceContext?.transcriptId===transcriptId);
  const recipients=(participants||[]).map(p=>p.matchedEmail||p.email||p.matchedContactName||p.speakerNameRaw||'').filter(Boolean);
  return saveInternalDraft({id:existing?.id,draftType:'meeting_recap',provider:'internal',subject:rendered.subject,body:rendered.textBody,status:'draft',sourceContext:{...(existing?.sourceContext||{}),source:'transcript_intelligence',transcriptId,transcriptTitle:title,meetingTitle:title,recipients,templateKey:MEETING_RECAP_TEMPLATE_KEY,templateId:rendered.template.id,htmlBody:rendered.htmlBody,plainTextBody:rendered.textBody}});
}
app.get('/api/val/templates/:templateKey',async(req,res)=>{
  try{const template=await getActiveTemplate(req.params.templateKey);if(!template)return res.status(404).json({ok:false,error:'Template not found'});res.json({ok:true,template});}
  catch(e){res.status(500).json({ok:false,error:e.message});}
});
app.put('/api/val/templates/:templateKey',async(req,res)=>{
  try{res.json({ok:true,template:await saveTemplate(req.params.templateKey,req.body||{})});}
  catch(e){res.status(500).json({ok:false,error:e.message});}
});

function rowToDraft(row){
  return {id:row.id,userId:row.user_id,tenantId:row.tenant_id,draftType:row.draft_type,contactId:row.contact_id||'',provider:row.provider,subject:row.subject||'',body:row.body||'',status:row.status,sourceContext:row.source_context_json||{},createdAt:row.created_at?row.created_at.toISOString():new Date().toISOString(),updatedAt:row.updated_at?row.updated_at.toISOString():new Date().toISOString()};
}
async function saveInternalDraft(payload){
  if(DEMO_MODE){
    const state=requestContext.getStore()?.demoState;
    const draft={id:payload.id||uuid('demo-draft'),userId:'demo-user',tenantId:'demo-val',draftType:payload.draftType||payload.draft_type||'follow_up',contactId:payload.contactId||payload.contact_id||'',provider:payload.provider||'internal',subject:payload.subject||'',body:payload.body||'',status:payload.status||'draft',sourceContext:payload.sourceContext||payload.source_context_json||{},createdAt:payload.createdAt||new Date().toISOString(),updatedAt:new Date().toISOString()};
    if(state){
      const idx=state.drafts.findIndex(d=>d.id===draft.id);
      if(idx>=0) state.drafts[idx]={...state.drafts[idx],...draft}; else state.drafts.unshift(draft);
    }
    return draft;
  }
  await valDbReady;
  const draft={id:payload.id||uuid('draft'),userId:payload.userId||currentUserId(),tenantId:tenantId(),draftType:payload.draftType||payload.draft_type||'follow_up',contactId:payload.contactId||payload.contact_id||'',provider:payload.provider||'internal',subject:payload.subject||'',body:payload.body||'',status:payload.status||'draft',sourceContext:payload.sourceContext||payload.source_context_json||{}};
  if(pgPool){
    const r=await dbQuery(`
      insert into drafts (id,user_id,tenant_id,draft_type,contact_id,provider,subject,body,status,source_context_json,created_at,updated_at)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now(),now())
      on conflict (id) do update set draft_type=excluded.draft_type,contact_id=excluded.contact_id,provider=excluded.provider,subject=excluded.subject,body=excluded.body,status=excluded.status,source_context_json=excluded.source_context_json,updated_at=now()
      returning *
    `,[draft.id,draft.userId,draft.tenantId,draft.draftType,draft.contactId,draft.provider,draft.subject,draft.body,draft.status,JSON.stringify(draft.sourceContext)]);
    return rowToDraft(r.rows[0]);
  }
  const store=valStore();store.drafts=store.drafts||[];
  const idx=store.drafts.findIndex(d=>d.id===draft.id);
  const record={...draft,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
  if(idx>=0)store.drafts[idx]={...store.drafts[idx],...record}; else store.drafts.unshift(record);
  saveValStore(store);
  return record;
}
async function listDrafts(status=''){
  if(DEMO_MODE){
    const drafts=requestContext.getStore()?.demoState?.drafts || [];
    return cloneDemo(drafts.filter(d=>!status||d.status===status).slice(0,100));
  }
  await valDbReady;
  if(pgPool){
    const params=[currentUserId(),tenantId()];
    let sql='select * from drafts where user_id=$1 and tenant_id=$2';
    if(status){params.push(status);sql+=' and status=$3';}
    sql+=' order by created_at desc limit 100';
    const r=await dbQuery(sql,params);
    return r.rows.map(rowToDraft);
  }
  return (valStore().drafts||[]).filter(d=>d.userId===currentUserId()&&(!status||d.status===status)).slice(0,100);
}
app.get('/api/val/drafts',async(req,res)=>{
  try{
    let drafts=await listDrafts(req.query.status||'');
    if(req.query.transcriptId)drafts=drafts.filter(d=>String(d.sourceContext?.transcriptId||'')===String(req.query.transcriptId));
    res.json({ok:true,drafts});
  }catch(e){res.status(500).json({ok:false,error:e.message});}
});
app.post('/api/val/drafts',async(req,res)=>{try{res.json({ok:true,draft:await saveInternalDraft(req.body||{})});}catch(e){res.status(500).json({ok:false,error:e.message});}});
app.patch('/api/val/drafts/:id',async(req,res)=>{
  try{
    const existing=(await listDrafts()).find(d=>d.id===req.params.id);
    if(!existing)return res.status(404).json({ok:false,error:'Draft not found'});
    res.json({ok:true,draft:await saveInternalDraft({...existing,...req.body,id:req.params.id})});
  }catch(e){res.status(500).json({ok:false,error:e.message});}
});
app.post('/api/gmail/drafts',async(req,res)=>{
  try{
    const status=await getGoogleConnectionStatus(['https://www.googleapis.com/auth/gmail.compose']);
    const missing=status.missingScopes||[];
    const payload=req.body||{};
    if(missing.length){
      const draft=await saveInternalDraft({draftType:'email_reply',provider:'internal',subject:payload.subject||'',body:payload.body||'',sourceContext:{warning:'Gmail compose scope missing. Created internal draft instead.',to:payload.to||'',threadId:payload.threadId||''}});
      return res.status(202).json({ok:true,draftType:'internal',warning:'Gmail compose scope missing. Created internal draft instead.',draft});
    }
    const token=await getGoogleToken();
    if(!token){
      const draft=await saveInternalDraft({draftType:'email_reply',provider:'internal',subject:payload.subject||'',body:payload.body||'',sourceContext:{warning:lastGoogleAuthError||'Google auth required',to:payload.to||'',threadId:payload.threadId||''}});
      return res.status(202).json({ok:true,draftType:'internal',warning:'Google auth unavailable. Created internal draft instead.',draft});
    }
    const lines=[`To: ${payload.to||''}`,`Subject: ${payload.subject||''}`,'',payload.body||''];
    const raw=Buffer.from(lines.join('\r\n')).toString('base64url');
    const r=await fetch('https://www.googleapis.com/gmail/v1/users/me/drafts',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({message:{raw,threadId:payload.threadId||undefined}})});
    const d=await readJsonResponse(r);
    if(!r.ok) throw new Error(d.error?.message||`Gmail draft failed (${r.status})`);
    res.json({ok:true,draftType:'gmail',gmailDraft:d});
  }catch(e){res.status(500).json({ok:false,error:e.message});}
});

function googleDocIdFromInput(value){
  const raw=String(value||'').trim();
  if(!raw) return '';
  const urlMatch=raw.match(/\/document\/d\/([a-zA-Z0-9_-]+)/);
  if(urlMatch) return urlMatch[1];
  const paramMatch=raw.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if(paramMatch) return paramMatch[1];
  const bare=raw.match(/^[a-zA-Z0-9_-]{20,}$/);
  return bare?raw:'';
}
function googleDocUrl(id){
  return id?`https://docs.google.com/document/d/${encodeURIComponent(id)}/edit`:'';
}
async function googleDocsToken(){
  const status=await getGoogleConnectionStatus(REQUIRED_GOOGLE_DOC_SCOPES);
  const token=await getGoogleToken();
  if(!token) throw new Error(status.error||'Google auth required');
  if(status.missingScopes.length) throw new Error('Reconnect Google to grant Docs/Drive scopes: '+status.missingScopes.join(', '));
  return token;
}
async function googleApiJson(url,opts={}){
  const r=await fetch(url,opts);
  const d=await readJsonResponse(r);
  if(!r.ok||d.error) throw new Error(d.error?.message||d.error_description||`Google API failed (${r.status})`);
  return d;
}
function googleDocEndIndex(doc){
  const content=doc?.body?.content||[];
  const last=content[content.length-1]||{};
  return Math.max(1,Number(last.endIndex||1)-1);
}
function googleDocInsertRequests(doc,text,mode){
  const clean=String(text||'').replace(/\r\n/g,'\n').trim();
  if(!clean) throw new Error('Missing document content');
  const endIndex=googleDocEndIndex(doc);
  const requests=[];
  if(mode==='replace'&&endIndex>1){
    requests.push({deleteContentRange:{range:{startIndex:1,endIndex}}});
    requests.push({insertText:{location:{index:1},text:clean+'\n'}});
  }else if(mode==='prepend'){
    requests.push({insertText:{location:{index:1},text:clean+'\n\n'}});
  }else{
    requests.push({insertText:{location:{index:endIndex},text:(endIndex>1?'\n\n':'')+clean+'\n'}});
  }
  return requests;
}
async function createGoogleDoc({title,content,folderId}){
  const token=await googleDocsToken();
  const metadata={name:String(title||'VAL Document').trim()||'VAL Document',mimeType:'application/vnd.google-apps.document'};
  if(folderId) metadata.parents=[folderId];
  const file=await googleApiJson('https://www.googleapis.com/drive/v3/files?fields=id,name,webViewLink,mimeType',{
    method:'POST',
    headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
    body:JSON.stringify(metadata)
  });
  const doc=await googleApiJson(`https://docs.googleapis.com/v1/documents/${encodeURIComponent(file.id)}`,{headers:{Authorization:`Bearer ${token}`}});
  await googleApiJson(`https://docs.googleapis.com/v1/documents/${encodeURIComponent(file.id)}:batchUpdate`,{
    method:'POST',
    headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
    body:JSON.stringify({requests:googleDocInsertRequests(doc,content,'replace')})
  });
  return {id:file.id,title:file.name||metadata.name,url:file.webViewLink||googleDocUrl(file.id)};
}
async function updateGoogleDoc({documentId,content,mode}){
  const token=await googleDocsToken();
  const id=googleDocIdFromInput(documentId);
  if(!id) throw new Error('Paste a Google Docs URL or document ID.');
  const doc=await googleApiJson(`https://docs.googleapis.com/v1/documents/${encodeURIComponent(id)}`,{headers:{Authorization:`Bearer ${token}`}});
  await googleApiJson(`https://docs.googleapis.com/v1/documents/${encodeURIComponent(id)}:batchUpdate`,{
    method:'POST',
    headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
    body:JSON.stringify({requests:googleDocInsertRequests(doc,content,mode||'append')})
  });
  return {id,title:doc.title||'Google Doc',url:googleDocUrl(id),mode:mode||'append'};
}
function googleDriveQueryEscape(value){
  return String(value||'').replace(/\\/g,'\\\\').replace(/'/g,"\\'");
}
function googleDocTextFromStructuralElements(elements=[]){
  let out='';
  for(const el of elements||[]){
    if(el.paragraph){
      for(const part of el.paragraph.elements||[]) out+=part.textRun?.content||'';
    }
    if(el.table){
      for(const row of el.table.tableRows||[]){
        for(const cell of row.tableCells||[]) out+=googleDocTextFromStructuralElements(cell.content||[]);
        out+='\n';
      }
    }
    if(el.tableOfContents) out+=googleDocTextFromStructuralElements(el.tableOfContents.content||[]);
  }
  return out;
}
function likelyGoogleDocSearches(query){
  const raw=String(query||'').trim();
  const searches=[];
  const chapter=raw.match(/\bchapter\s*(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/i);
  if(chapter) searches.push(('Chapter '+chapter[1]).replace(/\b\w/g,c=>c.toUpperCase()));
  const quoted=raw.match(/["“]([^"”]{3,120})["”]/);
  if(quoted) searches.push(quoted[1]);
  const cleaned=raw
    .replace(/\b(can you|please|could you|read|review|open|find|pull up|look at|the|my|our|doc|docs|document|google|drive|chapter|memoir)\b/ig,' ')
    .replace(/[^a-z0-9\s_-]/ig,' ')
    .replace(/\s+/g,' ')
    .trim();
  if(cleaned.length>=3) searches.push(cleaned);
  const projectTerms=[CLIENT_CONFIG.projectName,CLIENT_CONFIG.brandName].map(s=>String(s||'').trim()).filter(Boolean);
  for(const projectTerm of projectTerms){
    searches.push(projectTerm);
    if(chapter) searches.push(projectTerm+' Chapter '+chapter[1]);
    else if(cleaned) searches.push(projectTerm+' '+cleaned);
  }
  return [...new Set(searches.map(s=>String(s||'').trim()).filter(Boolean))].slice(0,5);
}
async function searchGoogleDocs(query,limit=8){
  const token=await googleDocsToken();
  const searches=likelyGoogleDocSearches(query);
  const seen=new Set(), files=[];
  for(const search of searches.length?searches:[query]){
    const safe=googleDriveQueryEscape(search);
    const q=[
      "mimeType = 'application/vnd.google-apps.document'",
      "trashed = false",
      `(name contains '${safe}' or fullText contains '${safe}')`
    ].join(' and ');
    const url='https://www.googleapis.com/drive/v3/files?'+new URLSearchParams({
      q,
      fields:'files(id,name,modifiedTime,webViewLink,mimeType)',
      orderBy:'modifiedTime desc',
      pageSize:String(limit)
    }).toString();
    const d=await googleApiJson(url,{headers:{Authorization:`Bearer ${token}`}});
    for(const f of d.files||[]){
      if(!seen.has(f.id)){seen.add(f.id);files.push(f);}
    }
    if(files.length>=limit) break;
  }
  return files.slice(0,limit);
}
async function readGoogleDoc({documentId,query}){
  const token=await googleDocsToken();
  let id=googleDocIdFromInput(documentId||query||'');
  let match=null, matches=[];
  if(!id){
    matches=await searchGoogleDocs(query||'',8);
    match=matches[0]||null;
    id=match?.id||'';
  }
  if(!id) throw new Error('No matching Google Doc found. Try the exact document title or paste the Google Doc URL.');
  const doc=await googleApiJson(`https://docs.googleapis.com/v1/documents/${encodeURIComponent(id)}`,{headers:{Authorization:`Bearer ${token}`}});
  const text=googleDocTextFromStructuralElements(doc.body?.content||[]).trim();
  return {id,title:doc.title||match?.name||'Google Doc',url:googleDocUrl(id),text,match,otherMatches:matches.slice(1,5)};
}
async function googleDocsContextForQuery(query){
  if(!/\b(read|review|open|find|pull up|look at|chapter|manuscript|memoir|document|doc|google doc|drive)\b/i.test(String(query||''))) return '';
  try{
    const doc=await readGoogleDoc({query});
    if(!doc.text) return `Google Doc found but no readable text was returned.\nTitle: ${doc.title}\nURL: ${doc.url}`;
    await saveMemoryItem({kind:'google_doc_read',summary:`Read Google Doc: ${doc.title}`,rawText:doc.text.slice(0,12000),importance:4,metadata:{source:'google_docs',documentId:doc.id,url:doc.url,title:doc.title}});
    return [
      `Google Doc source found for the user's request.`,
      `Title: ${doc.title}`,
      `URL: ${doc.url}`,
      doc.otherMatches?.length?`Other possible matches: ${doc.otherMatches.map(f=>f.name).join(', ')}`:'',
      `Document text:\n${doc.text.slice(0,45000)}`
    ].filter(Boolean).join('\n\n');
  }catch(e){
    if(/auth|required|scope|reconnect/i.test(e.message)) return `Google Docs are not readable yet: ${e.message}. Tell the user to reconnect Google from Integration Status and approve Drive/Docs permissions.`;
    return `Google Docs lookup did not find a readable matching document: ${e.message}`;
  }
}
function isGoogleDocRewriteRequest(query){
  const text=String(query||'').toLowerCase();
  return /\b(rewrite|revise|redraft|rework|polish|line edit|developmental edit|edit)\b/.test(text)
    && /\b(chapter|manuscript|memoir|book|google doc|document|doc|draft)\b/.test(text);
}
function isWholeDocumentRewriteRequest(query){
  return /\b(entire|whole|full|all of|complete)\b/i.test(String(query||''))
    && /\b(document|doc|google doc|manuscript|memoir|book|draft)\b/i.test(String(query||''));
}
function googleDocRewriteTitle(sourceTitle,query,scope){
  const chapter=String(query||'').match(/\bchapter\s*(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/i);
  const label=scope==='chapter'&&chapter?`Chapter ${chapter[1]} Rewrite`:'Full Document Rewrite';
  const base=String(sourceTitle||label).replace(/\s+/g,' ').trim();
  return `${label} - ${base} - ${new Date().toISOString().slice(0,10)}`;
}
function splitChapterText(text,maxChars=18000){
  const clean=String(text||'').replace(/\r\n/g,'\n').trim();
  if(clean.length<=maxChars) return clean?[clean]:[];
  const paras=clean.split(/\n{2,}/);
  const chunks=[];
  let current='';
  for(const para of paras){
    const next=current ? current+'\n\n'+para : para;
    if(next.length<=maxChars){current=next;continue;}
    if(current){chunks.push(current);current='';}
    if(para.length<=maxChars){current=para;continue;}
    for(let i=0;i<para.length;i+=maxChars) chunks.push(para.slice(i,i+maxChars));
  }
  if(current) chunks.push(current);
  return chunks;
}
const CHAPTER_WORD_NUMBERS = {one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10,eleven:11,twelve:12,thirteen:13,fourteen:14,fifteen:15,sixteen:16,seventeen:17,eighteen:18,nineteen:19,twenty:20};
function requestedChapterNumber(query){
  const m=String(query||'').match(/\bchapter\s*(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\b/i);
  if(!m) return null;
  const raw=m[1].toLowerCase();
  return /^\d+$/.test(raw)?Number(raw):CHAPTER_WORD_NUMBERS[raw]||null;
}
function extractRequestedChapterText(fullText,query){
  const chapter=requestedChapterNumber(query);
  const text=String(fullText||'').replace(/\r\n/g,'\n');
  if(!chapter||!text) return '';
  const word=Object.entries(CHAPTER_WORD_NUMBERS).find(([,n])=>n===chapter)?.[0]||'';
  const headingRe=new RegExp(`^\\s*(chapter\\s+(${chapter}${word?'|'+word:''})\\b[^\\n]*|${chapter}[\\.)\\:-]\\s+[^\\n]{0,120})\\s*$`,'im');
  const start=text.search(headingRe);
  if(start<0) return '';
  const rest=text.slice(start);
  const nextRe=/^\s*(chapter\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\b[^\n]*|\d+[\.)\:-]\s+[^\n]{0,120})\s*$/gim;
  let next=-1, match;
  while((match=nextRe.exec(rest))){
    if(match.index===0) continue;
    const raw=String(match[2]||match[1].match(/^\s*(\d+)/)?.[1]||'').toLowerCase();
    const n=/^\d+$/.test(raw)?Number(raw):CHAPTER_WORD_NUMBERS[raw]||null;
    if(!n||n>chapter){next=match.index;break;}
  }
  return (next>0?rest.slice(0,next):rest).trim();
}
function nestedRecordMetadata(record={}){
  const meta=record.metadata||{};
  return {...meta,...(meta.metadata||{})};
}
function valUploadedSourceTitle(record={}){
  const meta=nestedRecordMetadata(record);
  return meta.chapterTitle||meta.fileName||record.title||record.summary||'Uploaded VAL document';
}
function scoreValRewriteSource(record,query){
  const meta=nestedRecordMetadata(record);
  const text=String(record.rawText||record.raw_text||'').trim();
  if(text.length<400) return 0;
  const q=String(query||'').toLowerCase();
  const hay=[record.type,record.kind,record.title,record.summary,meta.fileName,meta.docType,meta.project,meta.projectType,meta.source,meta.chapterTitle,CLIENT_CONFIG.projectName,CLIENT_CONFIG.brandName].join(' ').toLowerCase();
  let score=0;
  if(/\bknowledge_document|processed_transcript|transcript\b/.test(String(record.type||record.kind||''))) score+=2;
  if(String(meta.source||'')==='val_file_upload') score+=7;
  if(/\b(manuscript|memoir|book|chapter|draft|knowledge_document)\b/.test(hay)) score+=5;
  if(isBookEditorProject()) score+=3;
  if(CLIENT_CONFIG.projectName&&hay.includes(String(CLIENT_CONFIG.projectName).toLowerCase())) score+=4;
  if(CLIENT_CONFIG.brandName&&hay.includes(String(CLIENT_CONFIG.brandName).toLowerCase())) score+=4;
  const chapter=requestedChapterNumber(query);
  if(chapter&&String(meta.chapterNumber||'')===String(chapter)) score+=8;
  if(chapter&&new RegExp(`\\bchapter\\s*${chapter}\\b`,'i').test(hay)) score+=5;
  if(isWholeDocumentRewriteRequest(query)&&/\b(manuscript|memoir|book)\b/.test(hay)) score+=7;
  if(isWholeDocumentRewriteRequest(query)&&text.length>12000) score+=Math.min(8,Math.floor(text.length/12000));
  const quoted=String(query||'').match(/["“]([^"”]{3,120})["”]/);
  if(quoted&&hay.includes(quoted[1].toLowerCase())) score+=10;
  const cleaned=q.replace(/\b(can you|please|could you|rewrite|revise|redraft|rework|polish|line edit|developmental edit|edit|entire|whole|full|all of|complete|the|my|our|doc|docs|document|google|drive|chapter|manuscript|memoir|book|draft)\b/g,' ').replace(/[^a-z0-9\s_-]/g,' ').replace(/\s+/g,' ').trim();
  if(cleaned.length>=3&&hay.includes(cleaned)) score+=6;
  return score;
}
async function readValUploadedRewriteSource({query,documentId}={}){
  if(documentId) return null;
  const [transcripts,memory]=await Promise.all([
    recentTranscripts(3650).catch(()=>[]),
    recentMemoryItems(3650,1000).catch(()=>[])
  ]);
  const fullRecords=(transcripts||[]).map(r=>({...r,sourceKind:'val_transcript'}));
  const chunkGroups=new Map();
  for(const item of memory||[]){
    const meta=nestedRecordMetadata(item);
    const transcriptId=meta.transcriptId||'';
    if(!transcriptId||!meta.chunkCount) continue;
    const existing=chunkGroups.get(transcriptId)||{...item,rawText:'',chunks:[],sourceKind:'val_memory_chunks'};
    existing.chunks.push(item);
    chunkGroups.set(transcriptId,existing);
  }
  const reconstructed=[...chunkGroups.values()].map(group=>{
    const chunks=group.chunks.sort((a,b)=>Number(nestedRecordMetadata(a).chunkIndex||0)-Number(nestedRecordMetadata(b).chunkIndex||0));
    return {...group,rawText:chunks.map(c=>c.rawText||c.raw_text||'').join('\n\n'),summary:chunks[0]?.summary||group.summary,metadata:chunks[0]?.metadata||group.metadata};
  });
  const candidates=[...fullRecords,...reconstructed]
    .map(record=>({record,score:scoreValRewriteSource(record,query)}))
    .filter(x=>x.score>0)
    .sort((a,b)=>b.score-a.score || String(b.record.rawText||'').length-String(a.record.rawText||'').length);
  const best=candidates[0]?.record;
  if(!best) return null;
  const text=String(best.rawText||best.raw_text||'').trim();
  return {id:best.id||'',title:valUploadedSourceTitle(best),url:'VAL uploaded file',text,source:'val_upload',record:best};
}
async function uploadedValDocumentContextForQuery(query){
  if(!/\b(read|review|open|find|pull up|look at|chapter|manuscript|memoir|document|doc|book|draft)\b/i.test(String(query||''))) return '';
  const doc=await readValUploadedRewriteSource({query}).catch(()=>null);
  if(!doc||!doc.text) return '';
  const requestedChapterText=extractRequestedChapterText(doc.text,query);
  const sourceText=requestedChapterText||doc.text;
  const scope=requestedChapterText?'requested chapter':'uploaded document';
  return [
    `Uploaded VAL ${scope} source found.`,
    `Title: ${doc.title}`,
    `Source: VAL memory upload`,
    `Readable characters available: ${doc.text.length}`,
    requestedChapterText?`Using extracted chapter characters: ${requestedChapterText.length}`:'',
    `Source text excerpt:\n${sourceText.slice(0,55000)}`
  ].filter(Boolean).join('\n\n');
}
async function rewriteGoogleDocChapter({query,documentId,targetDocumentId,mode='create'}){
  const doc=(await readValUploadedRewriteSource({query,documentId})) || await readGoogleDoc({documentId,query});
  if(!doc.text) throw new Error('Source document was found, but it did not contain readable text.');
  await googleDocsToken();
  const shouldExtractChapter=!!requestedChapterNumber(query)&&!isWholeDocumentRewriteRequest(query);
  const requestedChapterText=shouldExtractChapter?extractRequestedChapterText(doc.text,query):'';
  const sourceText=requestedChapterText||doc.text;
  const chunks=splitChapterText(sourceText,18000);
  if(!chunks.length) throw new Error('No document text found to rewrite.');
  const scope=requestedChapterText?'chapter':'document';
  const system=[
    VAL_SYSTEM_PROMPT,
    'You are rewriting memoir material for Michele.',
    'Rewrite the supplied source text fully, not a summary.',
    scope==='document'?'Keep the full document complete across all sections.':'Keep the chapter complete.',
    'Preserve the factual sequence, lived meaning, core scenes, and Michele voice.',
    'Improve memoir flow, emotional pacing, humor and levity, reader recognition, IFS prompt quality, transitions, and alignment with the book.',
    'Do not explain your edits. Return only rewritten prose for the supplied section.',
    'If a passage needs a placeholder because the source has an unclear factual gap, mark it briefly in brackets instead of inventing facts.'
  ].join('\n\n');
  const rewritten=[];
  for(let i=0;i<chunks.length;i++){
    const user=[
      `Source document: ${doc.title}`,
      `User request: ${query||'Rewrite this document.'}`,
      `Section ${i+1} of ${chunks.length}.`,
      i>0?'Continue seamlessly from the previous rewritten section. Do not restart or summarize.':(scope==='document'?'Start the rewritten document.':'Start the rewritten chapter.'),
      'Rewrite this source section fully:',
      chunks[i]
    ].filter(Boolean).join('\n\n');
    const section=await callValModel({system,user,maxTokens:6500,temperature:0.45});
    rewritten.push(String(section||'').trim());
  }
  const content=rewritten.filter(Boolean).join('\n\n').trim();
  if(!content) throw new Error('The rewrite returned no content.');
  const title=googleDocRewriteTitle(doc.title,query,scope);
  const output=(mode==='replace'||mode==='append'||targetDocumentId)
    ? await updateGoogleDoc({documentId:targetDocumentId||documentId||doc.id,content,mode:mode==='create'?'append':mode})
    : await createGoogleDoc({title,content});
  await saveMemoryItem({
    kind:'document_rewrite',
    summary:`Rewrote ${scope} from ${doc.source==='val_upload'?'VAL upload':'Google Doc'}: ${doc.title}`,
    rawText:content.slice(0,12000),
    importance:5,
    metadata:{source:doc.source||'google_docs',scope,sourceDocumentId:doc.id,sourceUrl:doc.url,outputDocumentId:output.id,outputUrl:output.url,title:output.title,chunkCount:chunks.length}
  });
  return {source:{id:doc.id,title:doc.title,url:doc.url,kind:doc.source||'google_docs',textLength:sourceText.length,scope,extractedChapter:!!requestedChapterText},output,chunkCount:chunks.length,rewrittenLength:content.length};
}
app.get('/api/google/docs/status',async(req,res)=>{
  try{
    const status=await getGoogleConnectionStatus(REQUIRED_GOOGLE_DOC_SCOPES);
    res.status(status.connected?200:400).json({ok:status.connected,connected:status.connected,hasRefreshToken:status.hasRefreshToken,scopes:status.scopes,missingScopes:status.missingScopes,error:status.error||''});
  }catch(e){res.status(500).json({ok:false,connected:false,error:e.message});}
});
app.post('/api/google/docs/create',async(req,res)=>{
  try{
    const result=await createGoogleDoc({title:req.body.title,content:req.body.content||req.body.body||'',folderId:req.body.folderId||''});
    await saveMemoryItem({kind:'google_doc_created',summary:`Created Google Doc: ${result.title}`,rawText:req.body.content||req.body.body||'',importance:3,metadata:{source:'google_docs',documentId:result.id,url:result.url,title:result.title}});
    res.json({ok:true,document:result});
  }catch(e){res.status(500).json({ok:false,error:e.message});}
});
app.post('/api/google/docs/update',async(req,res)=>{
  try{
    const result=await updateGoogleDoc({documentId:req.body.documentId||req.body.url||req.body.docUrl,content:req.body.content||req.body.body||'',mode:req.body.mode||'append'});
    await saveMemoryItem({kind:'google_doc_updated',summary:`Updated Google Doc: ${result.title}`,rawText:req.body.content||req.body.body||'',importance:3,metadata:{source:'google_docs',documentId:result.id,url:result.url,title:result.title,mode:result.mode}});
    res.json({ok:true,document:result});
  }catch(e){res.status(500).json({ok:false,error:e.message});}
});
app.get('/api/google/docs/search',async(req,res)=>{
  try{
    const files=await searchGoogleDocs(req.query.q||req.query.query||'',Number(req.query.limit)||8);
    res.json({ok:true,files});
  }catch(e){res.status(500).json({ok:false,error:e.message});}
});
app.post('/api/google/docs/read',async(req,res)=>{
  try{
    const doc=await readGoogleDoc({documentId:req.body.documentId||req.body.url||req.body.docUrl,query:req.body.query||''});
    await saveMemoryItem({kind:'google_doc_read',summary:`Read Google Doc: ${doc.title}`,rawText:doc.text.slice(0,12000),importance:4,metadata:{source:'google_docs',documentId:doc.id,url:doc.url,title:doc.title}});
    res.json({ok:true,document:{id:doc.id,title:doc.title,url:doc.url,text:doc.text,otherMatches:doc.otherMatches||[]}});
  }catch(e){res.status(500).json({ok:false,error:e.message});}
});
app.post('/api/google/docs/rewrite',async(req,res)=>{
  try{
    const result=await rewriteGoogleDocChapter({
      query:req.body.query||'Rewrite this chapter.',
      documentId:req.body.documentId||req.body.url||req.body.docUrl,
      targetDocumentId:req.body.targetDocumentId||req.body.targetUrl||'',
      mode:req.body.mode||'create'
    });
    res.json({ok:true,...result});
  }catch(e){res.status(500).json({ok:false,error:e.message});}
});

async function saveMemoryItem(payload){
  if(DEMO_MODE){
    const state=requestContext.getStore()?.demoState;
    if(state){
      state.memoryItems=state.memoryItems||[];
      state.memoryItems.unshift({id:payload.id||uuid('demo-mem'),kind:payload.kind||payload.type||'note',summary:payload.summary||'',rawText:payload.rawText||payload.transcript||payload.summary||'',importance:payload.importance||1,metadata:payload.metadata||{},createdAt:new Date().toISOString()});
    }
    return {id:payload.id||uuid('demo-mem')};
  }
  await valDbReady;
  const id=payload.id||uuid('mem');
  const rawText=payload.rawText||payload.transcript||payload.summary||'';
  if(pgPool){
    await dbQuery('insert into val_memory_items (id,user_id,kind,summary,raw_text,importance,metadata,created_at) values ($1,$2,$3,$4,$5,$6,$7,now())',[id,VAL_USER_ID,payload.kind||payload.type||'note',payload.summary||null,rawText,payload.importance||1,JSON.stringify(payload.metadata||{})]);
  }else{
    const store=valStore();
    store.memoryItems.unshift({id,userId:VAL_USER_ID,kind:payload.kind||payload.type||'note',summary:payload.summary||'',rawText,importance:payload.importance||1,metadata:payload.metadata||{},createdAt:new Date().toISOString()});
    saveValStore(store);
  }
  return {id};
}
const TRANSCRIPT_SAFE_MATCH_CONFIDENCE=0.82;
const TRANSCRIPT_SAFE_ACTION_CONFIDENCE=0.82;
function transcriptFileArray(store,key){if(!Array.isArray(store[key]))store[key]=[];return store[key];}
function transcriptDemoArray(key){const state=requestContext.getStore()?.demoState;if(!state)return null;if(!Array.isArray(state[key]))state[key]=[];return state[key];}
function valTitleCandidate(value){
  const title=String(value||'').replace(/\s+/g,' ').trim();
  if(!title)return '';
  const low=title.toLowerCase();
  const generic=[
    'transcript','webhook transcript','meeting transcript','call transcript','processed transcript','untitled transcript',
    'zoom transcript','recording transcript','meeting notes','call notes','transcript notes'
  ];
  if(generic.includes(low))return '';
  if(/^(prepare me for|summarize this past meeting|meeting prep|webhook|processed|untitled)(\b|:)/i.test(title))return '';
  if(/^(transcript|meeting|call|zoom|recording)\s*#?\d*$/i.test(title))return '';
  return title.slice(0,180);
}
function transcriptDateLabel(value){
  const d=value?new Date(value):null;
  if(!d||isNaN(d.getTime()))return '';
  return d.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});
}
function eventTitleFromContext(ctx={}){
  const meta=ctx.metadata||{},sourceMeta=meta.sourcePayloadMetadata||{};
  const event=ctx.calendarEvent||ctx.event||ctx.meetingMatch?.event||ctx.meetingMatch?.calendarEvent||{};
  return valTitleCandidate(ctx.calendarEventTitle||ctx.calendar_event_title||ctx.eventTitle||ctx.event_title||ctx.meetingMatch?.meetingTitle||ctx.meetingMatch?.calendarEventTitle||ctx.meetingMatch?.eventTitle||ctx.meetingMatch?.title||event.title||event.summary||event.name||meta.calendarEventTitle||meta.calendar_event_title||meta.eventTitle||meta.event_title||sourceMeta.calendarEventTitle||sourceMeta.eventTitle);
}
function transcriptDisplayTitleFromPayload(payload={},rawText=''){
  const meta=payload.metadata||{},sourceMeta=meta.sourcePayloadMetadata||{};
  const calendarTitle=eventTitleFromContext(payload);
  if(calendarTitle)return calendarTitle;
  const meetingTitle=valTitleCandidate(payload.meetingTitle||payload.meeting_title||payload.meetingName||payload.meeting_name||meta.meetingTitle||meta.meeting_name||sourceMeta.meetingTitle||sourceMeta.meeting_name);
  if(meetingTitle)return meetingTitle;
  const transcriptMetaTitle=valTitleCandidate(payload.callTitle||payload.call_title||payload.callName||payload.call_name||payload.title||meta.callTitle||meta.call_name||meta.title||sourceMeta.callTitle||sourceMeta.call_name||sourceMeta.title);
  if(transcriptMetaTitle)return transcriptMetaTitle;
  const contact=valTitleCandidate(payload.contactName||payload.contact_name||payload.personName||meta.contactName||meta.contact_name||meta.personName||sourceMeta.contactName||sourceMeta.personName);
  const company=valTitleCandidate(payload.companyName||payload.company||meta.companyName||meta.company||sourceMeta.companyName||sourceMeta.company);
  const date=transcriptDateLabel(payload.meetingDatetime||payload.meeting_datetime||payload.timestamp||payload.createdAt||payload.receivedAt||meta.timestamp||meta.createdAt);
  if(contact||company)return [contact||company,contact&&company?company:'',date].filter(Boolean).join(' · ');
  const speakers=[...String(rawText||payload.transcript||'').matchAll(/^\s*([^:\n]{2,50}):\s*.+$/gm)].map(m=>m[1].trim()).filter(n=>!/^https?|meeting|transcript|speaker$/i.test(n));
  const unique=[...new Set(speakers)].slice(0,3);
  if(unique.length)return unique.join('/')+(date?' · '+date:'');
  return 'Untitled Transcript';
}
function contextualTaskTitle(contextTitle,taskTitle){
  const task=cleanTaskTitle(taskTitle);
  const context=valTitleCandidate(contextTitle);
  if(!task)return context||'Untitled task';
  if(!context||task.toLowerCase().startsWith(context.toLowerCase()+' — '))return task;
  return `${context} — ${task}`;
}
async function saveTranscriptIndexRaw(payload,id){
  const rawTranscript=payload.transcript||payload.rawText||payload.text||'';
  const row={transcriptId:id,source:payload.source||payload.provider||'unknown',meetingTitle:transcriptDisplayTitleFromPayload(payload,rawTranscript),meetingDatetime:payload.meetingDatetime||payload.meeting_datetime||payload.timestamp||payload.createdAt||null,calendarEventId:payload.calendarEventId||payload.calendar_event_id||payload.meetingId||payload.meeting_id||'',rawTranscript,processingStatus:'received',summaryStatus:'pending',createdAt:payload.timestamp||payload.createdAt||new Date().toISOString(),updatedAt:new Date().toISOString()};
  if(DEMO_MODE){const rows=transcriptDemoArray('transcriptIndex');if(rows){const i=rows.findIndex(x=>x.transcriptId===id);if(i>=0)rows[i]={...rows[i],...row};else rows.unshift(row);}return row;}
  await valDbReady;
  if(pgPool){await dbQuery(`insert into transcripts (transcript_id,user_id,tenant_id,source,meeting_title,meeting_datetime,calendar_event_id,raw_transcript,processing_status,summary_status,created_at,updated_at) values ($1,$2,$3,$4,$5,$6,$7,$8,'received','pending',coalesce($9::timestamptz,now()),now()) on conflict (transcript_id) do update set source=excluded.source,meeting_title=excluded.meeting_title,meeting_datetime=coalesce(excluded.meeting_datetime,transcripts.meeting_datetime),calendar_event_id=coalesce(nullif(excluded.calendar_event_id,''),transcripts.calendar_event_id),raw_transcript=excluded.raw_transcript,updated_at=now()`,[id,VAL_USER_ID,CLIENT_CONFIG.clientSlug||'default',row.source,row.meetingTitle,row.meetingDatetime,row.calendarEventId,row.rawTranscript,row.createdAt]);}
  else{const store=valStore(),rows=transcriptFileArray(store,'transcriptIndex'),i=rows.findIndex(x=>x.transcriptId===id);if(i>=0)rows[i]={...rows[i],...row};else rows.unshift(row);saveValStore(store);}
  return row;
}
async function updateTranscriptIndexStatus(id,updates={}){
  const clean={processingStatus:updates.processingStatus,summaryStatus:updates.summaryStatus,calendarEventId:updates.calendarEventId,meetingDatetime:updates.meetingDatetime,meetingTitle:valTitleCandidate(updates.meetingTitle||updates.calendarEventTitle),updatedAt:new Date().toISOString()};
  if(DEMO_MODE){const row=(transcriptDemoArray('transcriptIndex')||[]).find(x=>x.transcriptId===id);if(row)Object.keys(clean).forEach(k=>clean[k]!==undefined&&(row[k]=clean[k]));return;}
  await valDbReady;
  if(pgPool){await dbQuery(`update transcripts set processing_status=coalesce($1,processing_status),summary_status=coalesce($2,summary_status),calendar_event_id=coalesce(nullif($3,''),calendar_event_id),meeting_datetime=coalesce($4::timestamptz,meeting_datetime),meeting_title=coalesce(nullif($5,''),meeting_title),updated_at=now() where transcript_id=$6 and user_id=$7`,[clean.processingStatus||null,clean.summaryStatus||null,clean.calendarEventId||'',clean.meetingDatetime||null,clean.meetingTitle||'',id,VAL_USER_ID]);}
  else{const store=valStore(),row=transcriptFileArray(store,'transcriptIndex').find(x=>x.transcriptId===id);if(row)Object.keys(clean).forEach(k=>clean[k]!==undefined&&(row[k]=clean[k]));saveValStore(store);}
}
async function logTranscriptAction(transcriptId,actionType,targetRecordId,status,errorMessage=''){
  const row={actionId:uuid('tr_action'),transcriptId,actionType,targetRecordId:targetRecordId||'',status,errorMessage:errorMessage||'',createdAt:new Date().toISOString()};
  if(DEMO_MODE){const rows=transcriptDemoArray('transcriptActionLog');if(rows)rows.push(row);return row;}
  await valDbReady;if(pgPool)await dbQuery('insert into transcript_action_log (action_id,transcript_id,action_type,target_record_id,status,error_message,created_at) values ($1,$2,$3,$4,$5,$6,now())',[row.actionId,transcriptId,actionType,row.targetRecordId,status,row.errorMessage||null]);else{const store=valStore();transcriptFileArray(store,'transcriptActionLog').push(row);saveValStore(store);}return row;
}
async function replaceTranscriptParticipants(transcriptId,participants){
  if(DEMO_MODE){const rows=transcriptDemoArray('transcriptParticipants');if(rows){for(let i=rows.length-1;i>=0;i--)if(rows[i].transcriptId===transcriptId)rows.splice(i,1);rows.push(...participants);}return;}
  await valDbReady;if(pgPool){await dbQuery('delete from transcript_participants where transcript_id=$1',[transcriptId]);for(const p of participants)await dbQuery(`insert into transcript_participants (participant_id,transcript_id,speaker_name_raw,matched_contact_id,matched_contact_name,matched_email,matched_phone,matched_company,match_confidence,match_reason,needs_review,created_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now())`,[p.participantId,transcriptId,p.speakerNameRaw,p.matchedContactId||null,p.matchedContactName||null,p.matchedEmail||null,p.matchedPhone||null,p.matchedCompany||null,p.matchConfidence||0,p.matchReason||'',!!p.needsReview]);}else{const store=valStore();store.transcriptParticipants=transcriptFileArray(store,'transcriptParticipants').filter(x=>x.transcriptId!==transcriptId);store.transcriptParticipants.push(...participants);saveValStore(store);}
}
async function saveTranscriptSummary(transcriptId,summary){
  const row={summaryId:uuid('tr_summary'),transcriptId,executiveSummary:summary.executiveSummary||summary.summary||'Summary unavailable.',clientSummary:summary.clientSummary||'',internalNotes:summary.internalNotes||'',keyDecisions:summary.keyDecisions||[],openQuestions:summary.openQuestions||[],relationshipUpdates:summary.relationshipUpdates||[],createdAt:new Date().toISOString()};
  if(DEMO_MODE){const rows=transcriptDemoArray('transcriptSummaries');if(rows){for(let i=rows.length-1;i>=0;i--)if(rows[i].transcriptId===transcriptId)rows.splice(i,1);rows.push(row);}}
  else{await valDbReady;if(pgPool){await dbQuery('delete from transcript_summaries where transcript_id=$1',[transcriptId]);await dbQuery(`insert into transcript_summaries (summary_id,transcript_id,executive_summary,client_summary,internal_notes,key_decisions,open_questions,relationship_updates,created_at) values ($1,$2,$3,$4,$5,$6,$7,$8,now())`,[row.summaryId,transcriptId,row.executiveSummary,row.clientSummary,row.internalNotes,JSON.stringify(row.keyDecisions),JSON.stringify(row.openQuestions),JSON.stringify(row.relationshipUpdates)]);}else{const store=valStore();store.transcriptSummaries=transcriptFileArray(store,'transcriptSummaries').filter(x=>x.transcriptId!==transcriptId);store.transcriptSummaries.push(row);saveValStore(store);}}
  await logTranscriptAction(transcriptId,'summary_created',row.summaryId,'completed');return row;
}
async function saveStagedTranscriptTask(row){
  if(DEMO_MODE){const rows=transcriptDemoArray('transcriptTasks');if(rows)rows.push(row);}
  else{await valDbReady;if(pgPool)await dbQuery(`insert into transcript_tasks (task_id,transcript_id,assigned_to_contact_id,assigned_to_name,task_title,task_description,due_date,priority,confidence,status,needs_approval,source_quote,created_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now())`,[row.taskId,row.transcriptId,row.assignedToContactId||null,row.assignedToName||null,row.taskTitle,row.taskDescription||'',row.dueDate||null,row.priority||'medium',row.confidence||0,row.status||'staged',!!row.needsApproval,row.sourceQuote]);else{const store=valStore();transcriptFileArray(store,'transcriptTasks').push(row);saveValStore(store);}}
  await logTranscriptAction(row.transcriptId,'task_extracted',row.taskId,'completed');return row;
}
async function updateStagedTranscriptTask(taskId,updates){
  if(DEMO_MODE){const row=(transcriptDemoArray('transcriptTasks')||[]).find(x=>x.taskId===taskId);if(row)Object.assign(row,updates);return row;}
  await valDbReady;if(pgPool){const r=await dbQuery('update transcript_tasks set status=coalesce($1,status),needs_approval=coalesce($2,needs_approval),assigned_to_contact_id=coalesce($3,assigned_to_contact_id),assigned_to_name=coalesce($4,assigned_to_name) where task_id=$5 returning *',[updates.status||null,updates.needsApproval===undefined?null:!!updates.needsApproval,updates.assignedToContactId||null,updates.assignedToName||null,taskId]);return r.rows[0];}const store=valStore(),row=transcriptFileArray(store,'transcriptTasks').find(x=>x.taskId===taskId);if(row)Object.assign(row,updates);saveValStore(store);return row;
}
async function saveStagedContactUpdate(row){
  if(DEMO_MODE){const rows=transcriptDemoArray('transcriptContactUpdates');if(rows)rows.push(row);}else{await valDbReady;if(pgPool)await dbQuery(`insert into transcript_contact_updates (update_id,transcript_id,contact_id,field_to_update,old_value,new_value,reason,source_quote,confidence,approved,created_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now())`,[row.updateId,row.transcriptId,row.contactId||null,row.fieldToUpdate,row.oldValue||'',row.newValue||'',row.reason||'',row.sourceQuote,row.confidence||0,!!row.approved]);else{const store=valStore();transcriptFileArray(store,'transcriptContactUpdates').push(row);saveValStore(store);}}
  await logTranscriptAction(row.transcriptId,'contact_update_extracted',row.updateId,'completed');return row;
}
function transcriptPgRow(row){
  if(!row)return row;
  const out={};
  for(const [key,value] of Object.entries(row))out[key.replace(/_([a-z])/g,(_,c)=>c.toUpperCase())]=value;
  ['keyDecisions','openQuestions','relationshipUpdates'].forEach(key=>{if(typeof out[key]==='string')try{out[key]=JSON.parse(out[key]);}catch(e){}});
  return out;
}
async function transcriptIndexData(transcriptId=''){
  if(DEMO_MODE){
    const get=key=>(transcriptDemoArray(key)||[]).filter(row=>!transcriptId||row.transcriptId===transcriptId);
    return {transcripts:get('transcriptIndex'),participants:get('transcriptParticipants'),summaries:get('transcriptSummaries'),tasks:get('transcriptTasks'),contactUpdates:get('transcriptContactUpdates'),actionLog:get('transcriptActionLog')};
  }
  await valDbReady;
  if(pgPool){
    const where=transcriptId?' and transcript_id=$2':'',args=transcriptId?[VAL_USER_ID,transcriptId]:[VAL_USER_ID];
    const transcripts=(await dbQuery(`select * from transcripts where user_id=$1${where} order by created_at desc`,args)).rows.map(transcriptPgRow);
    const ids=transcripts.map(row=>row.transcriptId);if(!ids.length)return {transcripts:[],participants:[],summaries:[],tasks:[],contactUpdates:[],actionLog:[]};
    const fetch=async table=>(await dbQuery(`select * from ${table} where transcript_id=any($1::text[]) order by created_at asc`,[ids])).rows.map(transcriptPgRow);
    return {transcripts,participants:await fetch('transcript_participants'),summaries:await fetch('transcript_summaries'),tasks:await fetch('transcript_tasks'),contactUpdates:await fetch('transcript_contact_updates'),actionLog:await fetch('transcript_action_log')};
  }
  const store=valStore(),get=key=>transcriptFileArray(store,key).filter(row=>!transcriptId||row.transcriptId===transcriptId);
  return {transcripts:get('transcriptIndex'),participants:get('transcriptParticipants'),summaries:get('transcriptSummaries'),tasks:get('transcriptTasks'),contactUpdates:get('transcriptContactUpdates'),actionLog:get('transcriptActionLog')};
}
function transcriptDetailFromIndex(data,transcript){
  const id=transcript.transcriptId;
  const participants=data.participants.filter(row=>row.transcriptId===id),tasks=data.tasks.filter(row=>row.transcriptId===id),contactUpdates=data.contactUpdates.filter(row=>row.transcriptId===id),actionLog=data.actionLog.filter(row=>row.transcriptId===id),summary=data.summaries.find(row=>row.transcriptId===id)||null;
  const reviewCount=participants.filter(row=>row.needsReview).length+tasks.filter(row=>row.needsApproval).length+contactUpdates.filter(row=>!row.approved).length;
  const title=transcriptDisplayTitleFromPayload({...transcript,title:transcript.meetingTitle,meetingTitle:transcript.meetingTitle,calendarEventTitle:transcript.calendarEventTitle},transcript.rawTranscript);
  return {...transcript,id,title,meetingTitle:title,createdAt:transcript.meetingDatetime||transcript.createdAt,transcriptText:transcript.rawTranscript,summary,participants,tasks,contactUpdates,actionLog,taskCount:tasks.length,reviewCount};
}
async function clearTranscriptStaging(transcriptId){
  if(DEMO_MODE){for(const key of ['transcriptParticipants','transcriptSummaries','transcriptTasks','transcriptContactUpdates','transcriptActionLog']){const rows=transcriptDemoArray(key)||[];for(let i=rows.length-1;i>=0;i--)if(rows[i].transcriptId===transcriptId)rows.splice(i,1);}return;}
  await valDbReady;
  if(pgPool){for(const table of ['transcript_action_log','transcript_contact_updates','transcript_tasks','transcript_summaries','transcript_participants'])await dbQuery(`delete from ${table} where transcript_id=$1`,[transcriptId]);return;}
  const store=valStore();for(const key of ['transcriptParticipants','transcriptSummaries','transcriptTasks','transcriptContactUpdates','transcriptActionLog'])store[key]=transcriptFileArray(store,key).filter(row=>row.transcriptId!==transcriptId);saveValStore(store);
}
async function saveTranscript(payload){
  const indexId=payload.id||uuid(DEMO_MODE?'demo-tr':'tr');
  payload={...payload,id:indexId};
  await saveTranscriptIndexRaw(payload,indexId);
  if(DEMO_MODE){
    const state=requestContext.getStore()?.demoState;
    const id=indexId;
    const type=payload.type||'transcript';
    const rawText=payload.transcript||payload.rawText||payload.text||'';
    const nested=payload.metadata&&typeof payload.metadata==='object'&&!Array.isArray(payload.metadata)?payload.metadata:{};
    const metadata={...nested,...payload,receivedAt:payload.receivedAt||new Date().toISOString()};
    delete metadata.metadata;delete metadata.transcript;delete metadata.rawText;delete metadata.raw_text;delete metadata.transcriptText;delete metadata.transcript_text;delete metadata.text;delete metadata.content;delete metadata.body;delete metadata.segments;delete metadata.sentences;
    if(state) state.transcripts.unshift({id,type,title:payload.title||'',rawText,metadata,createdAt:payload.timestamp||payload.createdAt||new Date().toISOString()});
    return {id,type};
  }
  await valDbReady;
  const id=indexId;
  const type=payload.type||'transcript';
  const rawText=payload.transcript||payload.rawText||payload.text||'';
  const nested=payload.metadata&&typeof payload.metadata==='object'&&!Array.isArray(payload.metadata)?payload.metadata:{};
  const metadata={...nested,...payload,receivedAt:payload.receivedAt||new Date().toISOString()};
  delete metadata.metadata;delete metadata.transcript;delete metadata.rawText;delete metadata.raw_text;delete metadata.transcriptText;delete metadata.transcript_text;delete metadata.text;delete metadata.content;delete metadata.body;delete metadata.segments;delete metadata.sentences;
  if(pgPool){
    await dbQuery('insert into val_transcripts (id,user_id,type,title,raw_text,metadata,created_at) values ($1,$2,$3,$4,$5,$6,coalesce($7::timestamptz,now()))',[id,VAL_USER_ID,type,payload.title||null,rawText,JSON.stringify(metadata),payload.timestamp||null]);
  }else{
    const store=valStore();
    store.transcripts.unshift({id,userId:VAL_USER_ID,type,title:payload.title||'',rawText,metadata,createdAt:payload.timestamp||new Date().toISOString()});
    saveValStore(store);
  }
  if(rawText){
    const chunks=memoryChunks(rawText);
    for(let i=0;i<chunks.length;i++){
      await saveMemoryItem({kind:type,summary:chunks.length>1?`${payload.title||type} (${i+1}/${chunks.length})`:payload.title||type,rawText:chunks[i],metadata:{...metadata,transcriptId:id,chunkIndex:i+1,chunkCount:chunks.length},importance:payload.importance||1});
    }
    const people=splitPeopleFromText([payload.title,rawText,JSON.stringify(metadata)].join(' ')).slice(0,8);
    const openLoops=extractOpenLoopsFromText(rawText,'transcript',payload.timestamp||payload.createdAt||new Date().toISOString()).slice(0,10);
    if(people.length||openLoops.length){
      await saveMemoryItem({
        kind:'relationship_memory',
        summary:`Relationship context from ${payload.title||type}`,
        rawText:[
          people.length?'People mentioned: '+people.map(p=>p.name||p.email).join(', '):'',
          openLoops.length?'Open loops:\n- '+openLoops.map(l=>l.text).join('\n- '):'',
          rawText.slice(0,2500)
        ].filter(Boolean).join('\n\n'),
        importance:openLoops.length?4:3,
        metadata:{...metadata,transcriptId:id,people,openLoops,source:'transcript_ingestion'}
      });
    }
  }
  return {id,type};
}
async function updateTranscriptMetadata(id,updates={}){
  if(!id||!updates||typeof updates!=='object') return;
  if(DEMO_MODE){
    const row=(requestContext.getStore()?.demoState?.transcripts||[]).find(t=>String(t.id)===String(id));
    if(row)row.metadata={...(row.metadata||{}),...updates};
    return;
  }
  await valDbReady;
  if(pgPool){
    await dbQuery('update val_transcripts set metadata=coalesce(metadata,\'{}\'::jsonb)||$1::jsonb where id=$2 and user_id=$3',[JSON.stringify(updates),id,VAL_USER_ID]);
    return;
  }
  const store=valStore(),row=(store.transcripts||[]).find(t=>String(t.id)===String(id));
  if(row){row.metadata={...(row.metadata||{}),...updates};saveValStore(store);}
}
async function recentTranscripts(days=7){
  if(DEMO_MODE) return cloneDemo(requestContext.getStore()?.demoState?.transcripts || []);
  await valDbReady;
  const since=new Date(Date.now()-Number(days)*24*60*60*1000).toISOString();
  if(pgPool){
    const r=await dbQuery('select id,type,title,raw_text,metadata,created_at from val_transcripts where user_id=$1 and created_at >= $2 order by created_at desc',[VAL_USER_ID,since]);
    return r.rows.map(row=>({id:row.id,type:row.type,title:row.title||'',rawText:row.raw_text||'',metadata:row.metadata||{},createdAt:row.created_at?row.created_at.toISOString():''}));
  }
  return (valStore().transcripts||[]).filter(t=>new Date(t.createdAt||0)>=new Date(since));
}
function isTranscriptMemoryRecord(item={}){
  const kind=String(item.kind||item.type||'').toLowerCase();
  const metadata=item.metadata||{};
  if(['transcript_insight','relationship_memory'].includes(kind)) return false;
  return /(^|_)transcript($|_)/.test(kind)||!!metadata.transcriptId;
}
async function transcriptArchiveRecords(days=3650,limit=500){
  const [stored,memory]=await Promise.all([recentTranscripts(days),recentMemoryItems(days,Math.max(limit*6,600))]);
  const byId=new Map();
  for(const row of (stored||[]).filter(Boolean))byId.set(String(row.id),{...row,metadata:row.metadata||{}});
  const legacyGroups=new Map();
  for(const item of (memory||[]).filter(isTranscriptMemoryRecord)){
    const metadata=item.metadata||{},id=String(metadata.transcriptId||item.id||'');
    if(!id)continue;
    if(byId.has(id)){
      const current=byId.get(id);
      current.metadata={...metadata,...(current.metadata||{})};
      if(!current.rawText)current.rawText=item.rawText||'';
      continue;
    }
    const group=legacyGroups.get(id)||[];group.push(item);legacyGroups.set(id,group);
  }
  for(const [id,items] of legacyGroups){
    items.sort((a,b)=>Number(a.metadata?.chunkIndex||1)-Number(b.metadata?.chunkIndex||1));
    const first=items[0],metadata=items.reduce((all,item)=>({...all,...(item.metadata||{})}),{});
    byId.set(id,{id,type:first.kind||first.type||'transcript',title:metadata.title||first.summary||'Recovered transcript',rawText:items.map(item=>item.rawText||'').filter(Boolean).join('\n\n'),metadata:{...metadata,recoveredFrom:'val_memory_items'},createdAt:first.createdAt||metadata.timestamp||metadata.createdAt||''});
  }
  return [...byId.values()].sort((a,b)=>interactionDate(b.createdAt)-interactionDate(a.createdAt)).slice(0,limit);
}
async function countTranscriptMeetingLinks(days=7){
  await valDbReady;
  const since=new Date(Date.now()-Number(days)*24*60*60*1000).toISOString();
  if(pgPool){
    const r=await dbQuery('select count(*)::int as count from meeting_transcript_links where user_id=$1 and tenant_id=$2 and created_at >= $3',[VAL_USER_ID,tenantId(),since]);
    return r.rows[0]?.count||0;
  }
  return (valStore().meetingTranscriptLinks||[]).filter(l=>l.userId===VAL_USER_ID&&l.tenantId===tenantId()&&new Date(l.createdAt||0)>=new Date(since)).length;
}
async function linkedTranscriptsForEvent(event,limit=5){
  await valDbReady;
  if(!event?.id) return [];
  const source=event.source||'unknown';
  if(pgPool){
    const r=await dbQuery(`
      select t.id,t.type,t.title,t.raw_text,t.metadata,t.created_at,l.confidence,l.matched_reason
      from meeting_transcript_links l
      join val_transcripts t on t.id=l.transcript_id
      where l.user_id=$1 and l.tenant_id=$2 and l.meeting_event_id=$3 and (l.meeting_source=$4 or l.meeting_source is null)
      order by l.created_at desc
      limit $5
    `,[VAL_USER_ID,tenantId(),event.id,source,limit]);
    return r.rows.map(row=>({id:row.id,type:row.type,title:row.title||'',createdAt:row.created_at?row.created_at.toISOString():'',confidence:Number(row.confidence||0),reason:row.matched_reason||'explicit transcript link',summary:String(row.raw_text||'').slice(0,900),metadata:row.metadata||{}}));
  }
  const store=valStore();
  const links=(store.meetingTranscriptLinks||[]).filter(l=>l.userId===VAL_USER_ID&&l.tenantId===tenantId()&&l.meetingEventId===event.id&&(!l.meetingSource||l.meetingSource===source)).slice(0,limit);
  const transcripts=store.transcripts||[];
  return links.map(l=>{
    const t=transcripts.find(tr=>tr.id===l.transcriptId);
    return t ? {id:t.id,type:t.type,title:t.title||'',createdAt:t.createdAt||'',confidence:Number(l.confidence||0),reason:l.matchedReason||'explicit transcript link',summary:String(t.rawText||'').slice(0,900),metadata:t.metadata||{}} : null;
  }).filter(Boolean);
}
function transcriptMeetingTitle(transcript){
  const text=[transcript.title,transcript.rawText,JSON.stringify(transcript.metadata||{})].join(' ');
  const explicit=String(transcript.title||'').replace(/\b(transcript|meeting|call|zoom|recording)\b/ig,' ').replace(/[^a-z0-9\s]/ig,' ').replace(/\s+/g,' ').trim();
  const source=[explicit,text].filter(Boolean).join(' ');
  const seen=new Set();
  const words=(source.toLowerCase().match(/[a-z0-9]{3,}/g)||[])
    .filter(w=>!['transcript','meeting','call','zoom','recording','with','from','this','that','notes','summary','unknown','processed','source','smoke','test','jessa'].includes(w))
    .filter(w=>{if(seen.has(w)) return false; seen.add(w); return true;})
    .slice(0,4);
  if(words.length>=3) return words.map(w=>w.charAt(0).toUpperCase()+w.slice(1)).join(' ');
  const people=splitPeopleFromText(text).slice(0,2).map(p=>p.name||p.email?.split('@')[0]).filter(Boolean);
  if(people.length) return people.concat(['Follow Up']).join(' ').split(/\s+/).slice(0,4).join(' ');
  return 'Retro Conversation Notes';
}
async function saveValCalendarEvent(event){
  await valDbReady;
  const id=event.id||uuid('vev');
  const record={id,userId:VAL_USER_ID,tenantId:tenantId(),source:event.source||'val',title:event.title||'Retro Conversation Notes',startTime:event.startTime||new Date().toISOString(),endTime:event.endTime||event.startTime||new Date().toISOString(),attendees:event.attendees||[],metadata:event.metadata||{}};
  if(pgPool){
    await dbQuery(`
      insert into val_calendar_events (id,user_id,tenant_id,source,title,start_time,end_time,attendees,metadata,created_at,updated_at)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,now(),now())
      on conflict (id) do update set title=excluded.title,start_time=excluded.start_time,end_time=excluded.end_time,attendees=excluded.attendees,metadata=excluded.metadata,updated_at=now()
    `,[record.id,record.userId,record.tenantId,record.source,record.title,record.startTime,record.endTime,JSON.stringify(record.attendees),JSON.stringify(record.metadata)]);
  }else{
    const store=valStore();store.calendarEvents=store.calendarEvents||[];
    const idx=store.calendarEvents.findIndex(e=>e.id===id);
    if(idx>=0)store.calendarEvents[idx]={...store.calendarEvents[idx],...record}; else store.calendarEvents.unshift(record);
    saveValStore(store);
  }
  return {id:record.id,title:record.title,summary:record.title,startTime:record.startTime,endTime:record.endTime,attendees:record.attendees,source:'val',calendarName:'VAL Retroactive Meetings',metadata:record.metadata};
}
async function fetchValCalendarEvents(start,end){
  await valDbReady;
  const s=start?.toISOString?start.toISOString():new Date(Date.now()-7*24*60*60*1000).toISOString();
  const e=end?.toISOString?end.toISOString():new Date(Date.now()+7*24*60*60*1000).toISOString();
  if(pgPool){
    const r=await dbQuery('select * from val_calendar_events where user_id=$1 and tenant_id=$2 and start_time >= $3 and start_time <= $4 order by start_time asc',[VAL_USER_ID,tenantId(),s,e]);
    return r.rows.map(row=>({id:row.id,title:row.title,summary:row.title,startTime:row.start_time?row.start_time.toISOString():'',endTime:row.end_time?row.end_time.toISOString():'',attendees:row.attendees||[],source:'val',calendarName:'VAL Retroactive Meetings',metadata:row.metadata||{}}));
  }
  return (valStore().calendarEvents||[]).filter(ev=>new Date(ev.startTime||0)>=new Date(s)&&new Date(ev.startTime||0)<=new Date(e));
}
function scoreTranscriptMeetingMatch(transcript,event){
  const tText=[transcript.title,transcript.rawText,JSON.stringify(transcript.metadata||{})].join(' ').toLowerCase();
  const eTitle=String(event.title||event.summary||'').toLowerCase();
  let score=0,reasons=[];
  if(eTitle&&tText.includes(eTitle.slice(0,80))){score+=0.45;reasons.push('title');}
  const attendees=inferAttendeesFromEvent(event);
  attendees.forEach(a=>{
    if(a.email&&tText.includes(a.email.toLowerCase())){score+=0.2;reasons.push('attendee email');}
    if(a.name&&a.name.length>3&&tText.includes(a.name.toLowerCase())){score+=0.12;reasons.push('attendee name');}
  });
  const ts=new Date(transcript.createdAt||transcript.metadata?.timestamp||transcript.metadata?.createdAt||0).getTime();
  const start=new Date(event.startTime||event.start||0).getTime();
  if(ts&&start&&Math.abs(ts-start)<4*60*60*1000){score+=0.25;reasons.push('time window');}
  return {confidence:Math.min(Number(score.toFixed(2)),1),reason:[...new Set(reasons)].join(', ')||'weak match'};
}
async function saveMeetingTranscriptLink({event,transcript,confidence,reason,contactId=''}){
  if(!event?.id||!transcript?.id) return null;
  const isRetro=event.source==='val' || event.metadata?.retroactive;
  if(!isRetro&&confidence<0.35) return null;
  if(!contactId){
    try{
      const contactRes=await resolveContactFromContext({calendarEvent:event,transcript:transcript.rawText||'',name:transcript.metadata?.contactName,email:transcript.metadata?.contactEmail});
      contactId=contactRes.contact?.contactId||contactRes.contact?.id||'';
    }catch(e){}
  }
  const record={id:uuid('mtl'),userId:VAL_USER_ID,tenantId:tenantId(),meetingSource:event.source||'unknown',meetingEventId:event.id,transcriptId:transcript.id,contactId,confidence,matchedReason:reason,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
  if(pgPool){
    await dbQuery(`
      insert into meeting_transcript_links (id,user_id,tenant_id,meeting_source,meeting_event_id,transcript_id,contact_id,confidence,matched_reason,updated_at)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,now())
      on conflict (user_id,tenant_id,meeting_source,meeting_event_id,transcript_id) do update set contact_id=coalesce(nullif(excluded.contact_id,''),meeting_transcript_links.contact_id),confidence=greatest(meeting_transcript_links.confidence,excluded.confidence),matched_reason=excluded.matched_reason,updated_at=now()
    `,[record.id,record.userId,record.tenantId,record.meetingSource,record.meetingEventId,record.transcriptId,record.contactId,record.confidence,record.matchedReason]);
  }else{
    const store=valStore();store.meetingTranscriptLinks=store.meetingTranscriptLinks||[];
    const idx=store.meetingTranscriptLinks.findIndex(l=>l.meetingEventId===record.meetingEventId&&l.transcriptId===record.transcriptId);
    if(idx>=0) store.meetingTranscriptLinks[idx]={...store.meetingTranscriptLinks[idx],...record,confidence:Math.max(Number(store.meetingTranscriptLinks[idx].confidence||0),Number(record.confidence||0))};
    else store.meetingTranscriptLinks.push(record);
    saveValStore(store);
  }
  return {...record,meetingTitle:event.title||event.summary||event.name||'',calendarEventTitle:event.title||event.summary||event.name||'',calendarEventId:event.id||''};
}
async function linkTranscriptToBestMeeting(transcript,options={}){
  const now=new Date(transcript.createdAt||Date.now());
  const start=new Date(now);start.setDate(start.getDate()-1);
  const end=new Date(now);end.setDate(end.getDate()+1);
  const events=[
    ...(await fetchGhlCalendarEvents(start,end).catch(()=>[])),
    ...(await fetchGoogleCalendarEvents(start,end,100).catch(()=>[])),
    ...(await fetchOutlookCalendarEvents(start,end,100).catch(()=>[])),
    ...(await fetchValCalendarEvents(start,end).catch(()=>[]))
  ];
  let best=null;
  for(const event of events){
    const m=scoreTranscriptMeetingMatch(transcript,event);
    if(!best||m.confidence>best.confidence) best={event,...m};
  }
  if(best&&best.confidence>=0.35) return saveMeetingTranscriptLink({event:best.event,transcript,confidence:best.confidence,reason:best.reason});
  if(options.createRetro!==false){
    const ts=transcript.createdAt||transcript.metadata?.timestamp||transcript.metadata?.createdAt||new Date().toISOString();
    const retro=await saveValCalendarEvent({
      title:transcriptMeetingTitle(transcript),
      startTime:ts,
      endTime:new Date(new Date(ts).getTime()+30*60*1000).toISOString(),
      attendees:splitPeopleFromText([transcript.title,transcript.rawText,JSON.stringify(transcript.metadata||{})].join(' ')).slice(0,8),
      metadata:{retroactive:true,createdFrom:'unmatched_transcript',transcriptId:transcript.id,originalTitle:transcript.title||''}
    });
    return saveMeetingTranscriptLink({event:retro,transcript,confidence:0.25,reason:'retroactive VAL meeting created for unmatched transcript'});
  }
  return null;
}
async function saveConversation(payload){
  if(DEMO_MODE){
    const state=requestContext.getStore()?.demoState;
    const id=payload.id||uuid('demo-chat');
    const messages=Array.isArray(payload.messages)?payload.messages:[];
    const title=payload.title||(messages.find(m=>m.role==='user')?.content||'Demo Conversation').slice(0,80);
    if(state){
      state.savedConversations=state.savedConversations||[];
      state.savedConversationMessages=state.savedConversationMessages||{};
      state.savedConversations=state.savedConversations.filter(c=>c.id!==id);
      state.savedConversations.unshift({id,title,source:payload.source||payload.type||'chat',metadata:payload.metadata||{},created_at:payload.timestamp||new Date().toISOString(),updated_at:new Date().toISOString()});
      state.savedConversationMessages[id]=messages.map(m=>({role:m.role||'user',content:m.content||'',metadata:m.metadata||{},created_at:m.timestamp||new Date().toISOString()}));
    }
    return {id,title,count:messages.length};
  }
  await valDbReady;
  const id=payload.id||uuid('conv');
  const messages=Array.isArray(payload.messages)?payload.messages:[];
  const title=payload.title||(messages.find(m=>m.role==='user')?.content||'Conversation').slice(0,80);
  if(pgPool){
    await dbQuery(`insert into val_conversations (id,user_id,title,source,metadata,created_at,updated_at) values ($1,$2,$3,$4,$5,coalesce($6::timestamptz,now()),now()) on conflict (id) do update set title=excluded.title, metadata=excluded.metadata, updated_at=now()`,[id,VAL_USER_ID,title,payload.source||payload.type||'chat',JSON.stringify(payload.metadata||{}),payload.timestamp||null]);
    await dbQuery('delete from val_messages where conversation_id=$1',[id]);
    for(const m of messages) await dbQuery('insert into val_messages (id,conversation_id,role,content,metadata,created_at) values ($1,$2,$3,$4,$5,coalesce($6::timestamptz,now()))',[uuid('msg'),id,m.role||'user',m.content||'',JSON.stringify(m.metadata||{}),m.timestamp||null]);
  }else{
    const store=valStore();
    store.conversations=store.conversations.filter(c=>c.id!==id);
    store.messages=store.messages.filter(m=>m.conversationId!==id);
    store.conversations.unshift({id,userId:VAL_USER_ID,title,source:payload.source||payload.type||'chat',metadata:payload.metadata||{},createdAt:payload.timestamp||new Date().toISOString(),updatedAt:new Date().toISOString()});
    messages.forEach(m=>store.messages.push({id:uuid('msg'),conversationId:id,role:m.role||'user',content:m.content||'',metadata:m.metadata||{},createdAt:m.timestamp||new Date().toISOString()}));
    saveValStore(store);
  }
  if(payload.transcript){
    const transcriptPayload={...payload,conversationId:id,title,type:payload.type||'chat_memory'};
    delete transcriptPayload.id;
    await saveTranscript(transcriptPayload);
  }
  return {id,title,count:messages.length};
}
async function recentMemoryContext(query){
  await valDbReady;
  const terms=queryTerms(query);
  const documentMode=isDocumentMemoryQuery(query);
  const format=items=>items.map(m=>`- [${m.kind}] ${(m.summary||m.raw_text||m.rawText||'').slice(0,140)}${(m.raw_text||m.rawText)&&((m.raw_text||m.rawText)!==m.summary)?': '+(m.raw_text||m.rawText).slice(0,documentMode?1200:650):''}`).join('\n');
  const metaOf=m=>typeof m.metadata==='string'?(()=>{try{return JSON.parse(m.metadata);}catch(e){return {};}})():(m.metadata||{});
  const uniqueByContent=items=>{const seen=new Set();return items.filter(m=>{const key=`${m.kind||''}|${m.summary||''}|${(m.raw_text||m.rawText||'').slice(0,80)}`;if(seen.has(key))return false;seen.add(key);return true;});};
  const recentDocumentPinned=items=>{
    if(!documentMode)return [];
    return items.filter(m=>/knowledge_document|processed_transcript|transcript/i.test(m.kind||'')).sort((a,b)=>{
      const ad=new Date(a.created_at||a.createdAt||0).getTime(),bd=new Date(b.created_at||b.createdAt||0).getTime();
      const am=metaOf(a),bm=metaOf(b);
      return (bd-ad)||(Number(am.chunkIndex||0)-Number(bm.chunkIndex||0));
    }).slice(0,10);
  };
  if(pgPool){
    const r=await dbQuery('select kind,summary,raw_text,importance,metadata,created_at from val_memory_items where user_id=$1 order by created_at desc limit 1200',[VAL_USER_ID]);
    const ranked=r.rows.map(m=>({...m,_score:scoreMemory(m,terms)})).sort((a,b)=>(b._score-a._score)||((b.importance||1)-(a.importance||1))).slice(0,documentMode?18:12);
    return format(uniqueByContent(recentDocumentPinned(r.rows).concat(ranked)).slice(0,documentMode?22:12));
  }
  const storeItems=valStore().memoryItems;
  const ranked=storeItems.map(m=>({...m,_score:scoreMemory(m,terms)})).sort((a,b)=>(b._score-a._score)||((b.importance||1)-(a.importance||1))).slice(0,documentMode?18:12);
  return format(uniqueByContent(recentDocumentPinned(storeItems).concat(ranked)).slice(0,documentMode?22:12));
}

function noteBody(note){
  if(!note)return '';
  const text=String(note.body||note.note||note.text||note.content||note.message||note.description||'').replace(/\s+/g,' ').trim();
  if(!text)return '';
  const ts=note.dateAdded||note.date_added||note.createdAt||note.created_at||note.updatedAt||note.updated_at;
  if(!ts)return text;
  const d=new Date(ts);
  const stamp=isNaN(d.getTime())?'':d.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});
  return stamp ? `${stamp}: ${text}` : text;
}
function normalizeNotesPayload(data){
  const raw=data?.notes||data?.data||data?.contactNotes||data?.contact_notes||data?.items||[];
  return Array.isArray(raw)?raw:[];
}
async function fetchContactNotes(contactId,limit=25){
  if(!contactId)return [];
  const encoded=encodeURIComponent(contactId);
  const ghlLoc=await resolveGhlLocationId();
  const paths=[
    `/contacts/${encoded}/notes`,
    `/contacts/${encoded}/notes?locationId=${encodeURIComponent(ghlLoc||GHL_LOC)}`,
    `/contacts/notes?contactId=${encoded}&locationId=${encodeURIComponent(ghlLoc||GHL_LOC)}`
  ];
  for(const path of paths){
    const r=await ghlTry('GET',path);
    const notes=normalizeNotesPayload(r.data).map(noteBody).filter(Boolean);
    if(r.ok&&notes.length)return notes.slice(0,limit);
  }
  return [];
}
function contactDisplayName(contact){
  const c=contact?.contact||contact||{};
  return c.contactName||c.name||[c.firstName,c.lastName].filter(Boolean).join(' ')||c.email||c.phone||'Unknown contact';
}
function likelyContactQueries(text){
  const raw=String(text||'');
  const emails=raw.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig)||[];
  const phones=raw.match(/\+?\d[\d\s().-]{7,}\d/g)||[];
  const quoted=[...raw.matchAll(/["']([^"']{3,80})["']/g)].map(m=>m[1]);
  const names=[...raw.matchAll(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})\b/g)].map(m=>m[1]).filter(v=>!/VAL|GOALL|GHL|CRM|Make|Zoom|Google|Mark Bierman/.test(v));
  return Array.from(new Set(emails.concat(phones,quoted,names,raw.slice(0,90)).map(v=>String(v).trim()).filter(v=>v.length>=3))).slice(0,6);
}
function collectContactIdsFromDashboard(dashboard){
  const ids=new Set();
  const walk=(value)=>{
    if(!value||ids.size>=8)return;
    if(Array.isArray(value)){value.forEach(walk);return;}
    if(typeof value==='object'){
      const id=value.contactId||value.contact_id||value.contact?.id;
      if(id)ids.add(String(id));
      Object.keys(value).slice(0,40).forEach(k=>walk(value[k]));
    }
  };
  walk(dashboard);
  return Array.from(ids).slice(0,8);
}
async function getContactNotesContextForId(contactId){
  try{
    const [contactData,notes]=await Promise.all([
      ghl('GET',`/contacts/${contactId}`).catch(()=>({})),
      fetchContactNotes(contactId,30)
    ]);
    const contact=contactData.contact||contactData;
    if(!notes.length)return '';
    return `Contact: ${contactDisplayName(contact)}${contact.email?' | '+contact.email:''}${contact.phone?' | '+contact.phone:''}\nGHL notes and call transcript history:\n- ${notes.join('\n- ')}`;
  }catch(e){return '';}
}
async function ghlContactNotesContext(query,dashboard){
  const ghlKey=await resolveIntegrationSecret('ghl','api_key',GHL_KEY);
  const ghlLoc=await resolveGhlLocationId();
  if(!ghlKey||!ghlLoc)return '';
  const sections=[];
  const seenIds=new Set();
  for(const id of collectContactIdsFromDashboard(dashboard||{})){
    if(seenIds.has(id))continue;
    seenIds.add(id);
    const ctx=await getContactNotesContextForId(id);
    if(ctx)sections.push(ctx);
  }
  for(const q of likelyContactQueries(query)){
    if(sections.length>=8)break;
    try{
      const d=await ghlMcp.searchContacts({query:q,limit:3});
      for(const c of (d.contacts||[])){
        const id=c.id||c.contactId;
        if(!id||seenIds.has(String(id)))continue;
        seenIds.add(String(id));
        const ctx=await getContactNotesContextForId(id);
        if(ctx)sections.push(ctx);
        if(sections.length>=8)break;
      }
    }catch(e){}
  }
  return sections.length ? sections.join('\n\n') : '';
}
async function ghlPlatformContext(query,dashboard,opts={}){
  if(!(await ghlMcp.isConfigured())) return '';
  const [crm,notes]=await Promise.all([
    ghlMcp.buildContext(query,{
      limit:opts.limit||8,
      opportunityLimit:opts.opportunityLimit||25,
      conversationLimit:opts.conversationLimit||8,
      notesLimit:opts.notesLimit||5,
      taskLimit:opts.taskLimit||5
    }).catch(e=>({text:'GHL platform context error: '+e.message})),
    ghlContactNotesContext(query,dashboard).catch(()=>'')
  ]);
  return [
    crm?.text||'',
    notes?'Targeted GHL note and call transcript history:\n'+notes:''
  ].filter(Boolean).join('\n\n');
}
async function callValModel({system,user,maxTokens=1200,temperature=0.4,json=false}){
  return callOpenAIResponses({system,messages:[{role:'user',content:user}],maxTokens,temperature,json});
}
function cleanTaskTitle(title){ return String(title||'').replace(/\s+/g,' ').trim(); }
function taskFingerprint(title,contactName){ return [cleanTaskTitle(title).toLowerCase(),String(contactName||'').trim().toLowerCase()].join('|'); }
function validDueDate(value){ if(!value)return null; const d=new Date(value); return isNaN(d.getTime())?null:d.toISOString(); }
function transcriptTaskFromItem(item,title,sourceId,kind){
  const taskTitle=cleanTaskTitle(item.title||item.task||item.action||item.nextAction);
  if(!taskTitle)return null;
  const contactName=item.contactName||item.person||item.who||item.for||item.owner||'';
  const notes=[item.notes||item.context||item.reason||'',item.priority?'Priority: '+item.priority:'',item.evidence?'Evidence: '+item.evidence:''].filter(Boolean).join('\n');
  return {id:uuid('task'),title:taskTitle,contactName,dueDate:validDueDate(item.dueDate||item.due||item.deadline),notes,details:[{text:'Created from transcript: '+title,ts:new Date().toISOString()},{text:'Source: '+(sourceId||title),ts:new Date().toISOString()},{text:'Kind: '+(kind||'commitment'),ts:new Date().toISOString()}],completed:false,createdAt:new Date().toISOString()};
}

const HUMAN_VOICE_RULES = `
Voice rules for every response:
Write like a real operator talking to another real person.
Do not use em dashes.
Do not use polished AI language, corporate filler, fake enthusiasm, or motivational-speaker energy.
Avoid phrases like "it's important to note", "in conclusion", "delve", "robust", "seamless", "transformative", "utilize", "unlock", "game-changing", "next-level", "dive into", and "elevate".
Do not over-explain. Leave obvious things alone.
Use plain words. Keep some edges.
Vary rhythm. Some sentences can be short. Some can be a little uneven.
Use bullets only when they help the user scan something operational.
Never sound like customer support. Never pad the ending.
If a sentence sounds polished just to sound smart, rewrite it.
`.trim();

function responseText(payload){
  if(payload.output_text) return payload.output_text;
  const parts = [];
  for(const item of payload.output||[]){
    for(const content of item.content||[]){
      if(content.text) parts.push(content.text);
    }
  }
  return parts.join('\n').trim();
}

async function callOpenAIResponses({system,messages,maxTokens=1200,temperature=0.4,json=false}){
  const openAiKey=await resolveOpenAIKey();
  const openAiModel=await resolveOpenAIModel();
  if(!openAiKey) throw new Error('OPENAI_KEY not configured');
  const body = {
    model:openAiModel,
    instructions:[system,HUMAN_VOICE_RULES].filter(Boolean).join('\n\n'),
    input:messages.map(m=>({
      role:m.role === 'assistant' ? 'assistant' : 'user',
      content:String(m.content||'')
    })),
    max_output_tokens:maxTokens,
    temperature
  };
  if(json) body.text = {format:{type:'json_object'}};
  let r=await fetch('https://api.openai.com/v1/responses',{
    method:'POST',
    headers:{'Content-Type':'application/json','Authorization':`Bearer ${openAiKey}`},
    body:JSON.stringify(body)
  });
  let d=await r.json();
  if(d.error && /temperature/i.test(d.error.message||'')){
    delete body.temperature;
    r=await fetch('https://api.openai.com/v1/responses',{
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':`Bearer ${openAiKey}`},
      body:JSON.stringify(body)
    });
    d=await r.json();
  }
  if(d.error) throw new Error(d.error.message);
  return responseText(d);
}

async function callOpenAIWebResearch({system,user,maxTokens=2200,temperature=0.1}){
  const openAiKey=await resolveOpenAIKey();
  const openAiModel=await resolveOpenAIModel();
  if(!openAiKey) throw new Error('OPENAI_KEY not configured');
  const body = {
    model: openAiModel,
    input: [
      {role:'system',content:system},
      {role:'user',content:user}
    ],
    tools: [{type:'web_search_preview'}],
    max_output_tokens: maxTokens,
    temperature
  };
  let r=await fetchWithTimeout('https://api.openai.com/v1/responses',{
    method:'POST',
    headers:{'Content-Type':'application/json','Authorization':`Bearer ${openAiKey}`},
    body:JSON.stringify(body)
  },OPENAI_WEB_RESEARCH_TIMEOUT_MS,'OpenAI web research');
  let d=await readJsonResponse(r);
  if(!r.ok && !d.error) throw new Error(`OpenAI web research failed (${r.status}): ${d.raw||'upstream error'}`);
  if(d.error && /temperature/i.test(d.error.message||'')){
    delete body.temperature;
    r=await fetchWithTimeout('https://api.openai.com/v1/responses',{
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':`Bearer ${openAiKey}`},
      body:JSON.stringify(body)
    },OPENAI_WEB_RESEARCH_TIMEOUT_MS,'OpenAI web research');
    d=await readJsonResponse(r);
    if(!r.ok && !d.error) throw new Error(`OpenAI web research failed (${r.status}): ${d.raw||'upstream error'}`);
  }
  if(d.error) throw new Error(d.error.message);
  return responseText(d);
}

const GOALL_LEADS_SYSTEM_PROMPT = `
You are Leads MCP GOALL, a focused lead generation and growth strategy specialist for the GOALL Agency.

Help users identify target markets, define ideal customer profiles, build prospecting systems, create outreach strategies, qualify leads, improve conversion rates, and develop repeatable pipeline growth processes.

Provide practical, results-oriented support for outbound campaigns, inbound lead capture, messaging, follow-up sequences, CRM organization, lead scoring, sales funnel optimization, and performance tracking.

When advising users, prioritize clarity, efficiency, and measurable outcomes. Ask smart discovery questions when needed, recommend actionable next steps, and tailor strategies to the user's industry, offer, audience, and growth stage.

Primary lead target:
- Employers
- Businesses
- Companies with employee bases
- Organizations with operational complexity
- Businesses showing hiring, growth, expansion, or activity signals
- Decision-makers such as founders, owners, CEOs, operations leaders, HR leaders, benefits leaders, sales leaders, and partnership leaders

GOALL caller intelligence objective:
- The scraper is not merely finding leads. It is preparing a caller to have a relevant business conversation.
- Every GOALL lead should make it clear why the company is worth contacting, what appears to be happening inside the business now, why leadership may care about retention, hiring, workforce stability, benefits, or growth, and what opening line the caller should use.
- Always produce a concise Lead Intelligence Summary in plain English.
- Always produce a Recommended First Call Angle that a caller can read directly or lightly personalize.
- The recommended angle should reference a real signal when available, such as expansion, hiring, employee count, leadership signal, active LinkedIn/company activity, job postings, reviews, or operational growth.

GOALL Arizona priority industries:
${GOALL_PRIORITY_INDUSTRIES_ARIZONA.map(v=>`- ${v}`).join('\n')}

GOALL pipeline volume standard:
- A GOALL pipeline with fewer than 300 people/prospects is not enough.
- Treat small scrape batches as preview batches or seed batches, not as a complete pipeline.
- If a scrape, import, or current pipeline is below 300 people, say plainly that pipeline volume is insufficient and recommend the next batch strategy.
- Do not imply the pipeline is healthy, complete, or sufficiently filled until it reaches at least 300 contactable people/prospects.
- Build toward 300 through repeated focused batches by industry, geography, and automation tag rather than one fragile oversized request.

When the user asks for "businesses in Arizona", "higher-income GOALL-fit businesses", "all priority industries", or a broad GOALL scrape without naming a niche, use the full GOALL Arizona priority industry set.

If the user names one industry, search only that industry.
If the user names multiple industries, search only those industries.

Viability rule:
- A lead is viable if it has a valid email OR a valid phone number.
- Email is not required.
- Phone-only leads are viable and should be marked as phone_only.
- Leads with neither email nor phone are not_contactable and should be rejected.

Contactability statuses:
- full_contactability: valid email and valid phone
- email_only: valid email and no valid phone
- phone_only: valid phone and no valid email
- not_contactable: neither valid email nor valid phone

GOALL fit scoring should favor higher-income, employee-heavy, operationally complex businesses such as trucking, construction, electrical, HVAC, plumbing, law offices, chiropractic offices, medical practices, manufacturing, staffing agencies, professional services, and home care agencies.

Every viable lead must receive a Lead Score from 1 to 4:
- 1 = Highest priority / best GOALL fit
- 2 = Strong fit
- 3 = Possible fit
- 4 = Low fit

Lead scoring rules:
- Do not leave leadScore blank.
- Do not use scores outside 1-4.
- 1 is best and 4 is lowest.
- Phone-only leads can still be Score 1 or Score 2 if business fit is strong.
- Lack of email should not automatically lower the score.
- No email and no phone means rejected, not viable.
- Include leadScore and leadScoreReason on every viable lead object.

Every GOALL lead must also include automationTag, automationTagReason, normalizedIndustry, rawIndustry, tagConfidence, needsNewAutomation, and suggestedNewAutomationTag.
Use only these automationTag values: Dentistry & Dental Practices, Education & Skilled Vocational Training, Electrical Contractors, HVAC, Hospitality / High-End Food Service, Information Technology / Professional Services, Manufacturing (Skilled Labor), Recruiters, Roofing & General Construction, Skilled Labor, Utilities & Energy Infrastructure, Home Services, Healthcare & Wellness Practices, Transportation & Logistics, Professional Services.
Do not invent new GHL automation tags. If a better future automation is needed, keep the closest allowed automationTag and put the recommendation in suggestedNewAutomationTag.

Score 1 when the company appears highly likely to benefit from GOALL: higher-income category, likely 10+ employees, recurring payroll need, likely benefit costs, commercial operation, active Google profile, professional website, usable contact info, and strong aligned industry.
Score 2 when the company appears like a good fit but employee size or benefit indicators are less clear.
Score 3 when fit is possible but uncertain due to limited employee evidence, smaller office possibility, unclear decision maker, or weak data.
Score 4 when the lead is contactable but likely small, low-fit, weakly aligned, or has little evidence of benefit needs.

CORE ROLE
You are a lead intelligence scraper and data structuring agent for GOALL.

Westwood mode:
When the request, client, or leadProfile indicates Westwood, operate as the Westwood International Limitless Leads scraper instead of GOALL.
Westwood searches target non-government, non-municipal private businesses, defaulting to Idaho, US.
Westwood prioritizes companies likely to need leadership development, executive coaching, team effectiveness, culture work, peer review, communication improvement, strategic alignment, employee engagement, manager development, and organizational growth support.
Use RocketReach for enrichment when person/company enrichment is needed. Do not use Apollo.
Westwood priority industries:
${WESTWOOD_PRIORITY_INDUSTRIES.map(v=>`- ${v}`).join('\n')}
Westwood lead score:
- 1 = Highest priority / best Westwood fit
- 2 = Strong fit
- 3 = Possible fit
- 4 = Low fit
Score 1 when the company appears private, likely 25+ employees, has a leadership team or multiple managers/departments, operational complexity, active business presence, aligned industry, and a decision-maker/contact path.
Score 2 when the company is private, active, aligned, and contactable, but employee count or leadership complexity is less clear.
Score 3 when fit is possible but uncertain.
Score 4 when the company appears solo, very small, weak-fit, inactive, or has poor evidence of leadership/team development need.

Your job:
- Search for company data across public sources
- Extract only relevant, verifiable information
- Normalize the data into structured CRM fields
- Reject or flag weak, unclear, or low-confidence data

You are not allowed to guess, fill gaps with assumptions, add commentary or opinions, or output messy/unstructured text.
If data cannot be verified, leave the field empty or mark it as "unclear".

PRIMARY OBJECTIVE
For each lead, collect and structure:
1. Company identity and operational context
2. Employee size indicators
3. Signals of hiring, growth, or activity
4. Public presence: website, LinkedIn, Google
5. Indicators of operational complexity
6. Best available decision-maker contact path
7. Plain-English caller intelligence summary
8. Specific first-call opening angle

SEARCH PROCESS - follow in order:
1. Search company name + city/state
2. Identify official website
3. Extract core company data
4. Search LinkedIn company page
5. Search LinkedIn people / likely decision-makers
6. Check Google Business
7. Scan for news, hiring, activity, expansion, funding, operations, and growth signals
8. Check hiring pages, public job postings, directories, business listings, and credible public sources for employee count or employee range
9. Check for workforce pain signals such as recruiting-heavy language, staffing difficulty, turnover, short-staffed reviews, burnout, scheduling issues, or heavy technician/crew hiring
10. Compile structured outputs

Source priority:
1. Official website
2. LinkedIn company page
3. Google Business listing
4. News / press mentions
5. Hiring pages / job postings
6. Secondary directories and business listings

Accuracy rules:
- Only include information that is directly observed, clearly stated, or strongly supported by multiple signals.
- Never invent employee counts, services, locations, contact info, decision-makers, or company descriptions.
- If exact employee count is unavailable, estimate only from supported signals such as LinkedIn employee range, job postings, team pages, or public staff count.
- Otherwise write "unclear".

Operational complexity signals:
Look for signs such as multiple locations, field teams, dispatch, service crews, employee benefits needs, hiring activity, sales teams, customer support teams, logistics, franchises, branch locations, certifications, recruiting pages, or high-volume customer operations.

Disqualifying or weak signals:
If you detect solo operator, no real business presence, broken/missing website, no employee signals, generic/fake listing, or weak public footprint, still collect data but clearly reflect weak signals.

OUTPUT FORMAT STRICT:
Return exactly these field labels and nothing else:

company_payload:
Company Name:
Industry:
Primary Service:
Business Model (if clear):
Location(s):
Website Status (active / weak / missing):

company_google_raw:
Google Business summary:
Reviews count:
Rating:
Description snippet:
If none: No Google data found

company_signals_raw:
- Hiring activity:
- Careers page:
- Team size indicators:
- Multiple locations:
- Operational indicators:
- Growth/activity signals:
- Weak-fit concerns:

company_news_raw:
[structured content]

linkedin_personal_url:
[most likely decision-maker URL or blank]

linkedin_company_url:
[company LinkedIn URL or fallback text]

estimated_employee_count:
[exact count or conservative range; blank only when no reasonable estimate exists]

employee_count_confidence:
[high / medium / low / unknown]

employee_count_note:
[brief note explaining source or why unknown]

growth_signals:
[new offices, expansion, services, markets, contracts, hiring surges, awards, or "No specific growth signal found yet."]

leadership_signals:
[current/recent CEO, COO, President, Owner, GM, VP Ops, HR Director, Benefits Manager, Sales Director, Office Manager, or "No named leadership signal found yet."]

workforce_pain_signals:
[hiring difficulty, recruiting, staffing pressure, reviews, burnout, scheduling, retention/benefits relevance, or "No clear workforce pain signal found yet."]

engagement_activity_signals:
[LinkedIn activity, website/news/community/company activity, recent announcements, or "Limited public engagement/activity signal found."]

decision_maker_name:
[name or blank]

decision_maker_title:
[title or blank]

decision_maker_email:
[email or blank]

decision_maker_phone:
[phone or blank]

decision_maker_linkedin:
[LinkedIn profile or blank]

company_linkedin:
[LinkedIn company page or blank]

goall_intelligence_note:
[concise plain-English Lead Intelligence Summary covering company overview, employee estimate, growth, leadership, workforce/hiring signals, why GOALL may be relevant, missing data, and first-call approach]

recommended_first_call_angle:
[one specific opening line the caller can use naturally]

missing_data:
[caller-critical missing data, or "No major caller-critical gaps."]
`.trim();

function parseLeadFieldOutputs(text){
  const fields=['company_payload','company_google_raw','company_signals_raw','company_news_raw','linkedin_personal_url','linkedin_company_url','estimated_employee_count','employee_count_confidence','employee_count_note','growth_signals','leadership_signals','workforce_pain_signals','engagement_activity_signals','decision_maker_name','decision_maker_title','decision_maker_email','decision_maker_phone','decision_maker_linkedin','company_linkedin','goall_intelligence_note','recommended_first_call_angle','missing_data'];
  const out={};
  fields.forEach((field,idx)=>{
    const next=fields[idx+1];
    const pattern=next
      ? new RegExp(`${field}:\\s*([\\s\\S]*?)(?=\\n${next}:)`, 'i')
      : new RegExp(`${field}:\\s*([\\s\\S]*)$`, 'i');
    const match=String(text||'').match(pattern);
    out[field]=match ? match[1].trim() : '';
  });
  return out;
}

function normalizeGhlFieldName(value){
  return String(value||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
}

function ghlCustomFieldId(field={}){
  return field.id||field._id||field.fieldId||field.customFieldId||'';
}

async function fetchGhlCustomFields(){
  const data=await ghl('GET',`/locations/${GHL_LOC}/customFields`);
  return data.customFields||data.fields||data.data||[];
}

function isSafeLeadScoreField(field={}){
  const normalizedName=normalizeGhlFieldName(field.name||field.fieldName||'');
  const normalizedKey=normalizeGhlFieldName(field.fieldKey||field.key||field.field_key||'');
  const combined=`${normalizedName} ${normalizedKey}`;
  if(/reason|why|notes?|date|time|at\b|created|updated|ingested|processed/.test(combined)) return false;
  return /\blead score\b|\bgoall lead score\b|\bgoall score\b|\bpriority score\b|\blead priority score\b|lead_score/.test(combined);
}

function leadCustomFieldPayloads(ids,fields){
  return Object.entries(ids)
    .filter(([key,id])=>id && Object.prototype.hasOwnProperty.call(fields,key))
    .map(([key,id])=>({id,key:GHL_LEAD_FIELD_KEYS[key],field_value:fields[key]||''}));
}

function assertRequiredLeadFieldIds(ids,required){
  const missing=(required||[]).filter(key=>!ids[key]);
  if(missing.length) throw new Error(`Missing required GHL lead custom field IDs: ${missing.join(', ')}. Set ${missing.map(key=>'GHL_FIELD_'+key.toUpperCase()).join(', ')} or create matching custom fields in GHL.`);
}

async function updateGhlLeadFields(contactId,fields){
  const ids = await resolveLeadFieldIds().catch(()=>GHL_LEAD_FIELD_IDS);
  const customFields = leadCustomFieldPayloads(ids,fields);
  if(!contactId || !customFields.length) return {updated:false, reason:contactId?'No lead custom field IDs configured':'No contactId provided'};
  const data=await ghlStrict('PUT',`/contacts/${contactId}`,{customFields});
  return {updated:true, contact:data.contact||data, fieldsUpdated:customFields.length};
}

function contactCustomFieldsFromPayload(payload){
  const contact=payload?.contact||payload;
  return contact?.customFields || contact?.customField || contact?.custom_fields || payload?.customFields || [];
}

function customFieldValueFromContact(payload,id,key){
  const fields=contactCustomFieldsFromPayload(payload);
  if(!Array.isArray(fields)) return undefined;
  const wantedId=String(id||'');
  const wantedKey=String(key||'').toLowerCase();
  const found=fields.find(f=>{
    const fid=String(f.id||f.fieldId||f.customFieldId||f._id||'');
    const fkey=String(f.key||f.fieldKey||'').toLowerCase();
    return (wantedId&&fid===wantedId) || (wantedKey&&fkey===wantedKey);
  });
  if(!found) return undefined;
  return found.field_value ?? found.value ?? found.fieldValue ?? found.values ?? '';
}

async function verifyGhlLeadScoreField(contactId,expectedScore,ids){
  const leadScoreId=ids?.lead_score;
  if(!leadScoreId) return {verified:false, reason:'lead_score field ID is missing'};
  const data=await ghlStrict('GET',`/contacts/${contactId}`);
  const actual=customFieldValueFromContact(data,leadScoreId,GHL_LEAD_FIELD_KEYS.lead_score);
  if(actual===undefined) return {verified:false, reason:'GHL contact response did not include the lead_score custom field'};
  const expected=String(expectedScore||'').trim();
  const received=Array.isArray(actual)?actual.join(','):String(actual||'').trim();
  return {verified:received===expected, expected, received, reason:received===expected?'Lead score verified in GHL':'Lead score value did not match after update'};
}

let leadFieldIdCache=null;
async function resolveLeadFieldIds(){
  if(leadFieldIdCache) return leadFieldIdCache;
  const resolved={...GHL_LEAD_FIELD_IDS};
  const missing=Object.entries(resolved).filter(([,id])=>!id);
  if(missing.length || resolved.lead_score){
    const fields=await fetchGhlCustomFields();
    for(const [key] of missing){
      const wantedKey=GHL_LEAD_FIELD_KEYS[key];
      const wantedName=key.replace(/_/g,' ').toLowerCase();
      const found=fields.find(f=>{
        const fieldKey=String(f.fieldKey||f.key||f.field_key||'').toLowerCase();
        const name=String(f.name||f.fieldName||'').toLowerCase();
        const aliases=(GHL_LEAD_FIELD_NAME_ALIASES[key]||[]).map(normalizeGhlFieldName);
        const normalizedName=normalizeGhlFieldName(name);
        const normalizedWanted=normalizeGhlFieldName(wantedName);
        const normalizedKey=normalizeGhlFieldName(fieldKey);
        if(key==='lead_score' && !isSafeLeadScoreField(f)) return false;
        return fieldKey===wantedKey
          || fieldKey.endsWith('.'+key)
          || normalizedKey.endsWith(normalizeGhlFieldName(key))
          || normalizedName===normalizedWanted
          || aliases.includes(normalizedName)
          || aliases.some(alias=>alias && normalizedName.includes(alias));
      });
      if(found) resolved[key]=ghlCustomFieldId(found);
    }
    if(resolved.lead_score){
      const scoreField=fields.find(f=>String(ghlCustomFieldId(f))===String(resolved.lead_score));
      if(!scoreField || !isSafeLeadScoreField(scoreField)) resolved.lead_score='';
    }
  }
  leadFieldIdCache=resolved;
  return resolved;
}

async function assertGoallLeadScoreField(ids){
  if(!ids?.lead_score) throw new Error('GOALL lead score custom field is not configured. Set GHL_FIELD_LEAD_SCORE to the exact GHL custom field id for Lead Score before importing GOALL leads.');
  const fields=await fetchGhlCustomFields();
  const field=fields.find(f=>String(ghlCustomFieldId(f))===String(ids.lead_score));
  if(!field) throw new Error(`Configured GHL_FIELD_LEAD_SCORE ${ids.lead_score} was not found in GHL custom fields.`);
  if(!isSafeLeadScoreField(field)){
    throw new Error(`Configured GHL_FIELD_LEAD_SCORE points to "${field.name||field.fieldName||ids.lead_score}", which does not look like the Lead Score field. Set it to the exact GHL Lead Score custom field id.`);
  }
  return field;
}

function normalizeLeadTag(value){
  const raw=String(value||'').toLowerCase();
  if(/\bgoall|priority|higher income\b/.test(raw) || /^(businesses|companies|employers)$/i.test(raw.trim())) return 'goall priority';
  if(/\btruck|freight|logistics|transport\b/.test(raw)) return 'trucking';
  if(/\bweld|metal fabricat|machine shop|manufactur|industrial\b/.test(raw)) return 'manufacturing';
  if(/\blaw|attorney|legal\b/.test(raw)) return 'law offices';
  if(/\baccounting|cpa|wealth|financial|insurance\b/.test(raw)) return 'professional services';
  if(/\bmedical|dental|chiropract|clinic|therapy|health|wellness|home care\b/.test(raw)) return 'healthcare';
  if(/\broof|hvac|plumb|electric|contractor|home service\b/.test(raw)) return 'home services';
  if(/\bdental|clinic|medical|health|wellness\b/.test(raw)) return 'healthcare';
  if(/\bmanufactur|industrial|warehouse|logistics\b/.test(raw)) return 'manufacturing';
  if(/\brestaurant|hotel|hospitality|catering\b/.test(raw)) return 'hospitality';
  if(/\bfranchise|multi.location|multi location|chain\b/.test(raw)) return 'multi-location';
  if(/\bagenc|marketing|consulting|professional service\b/.test(raw)) return 'professional services';
  return raw.trim() || 'business';
}

const GOALL_AUTOMATION_TAGS = [
  'Dentistry & Dental Practices',
  'Education & Skilled Vocational Training',
  'Electrical Contractors',
  'HVAC',
  'Hospitality / High-End Food Service',
  'Home Services',
  'Healthcare & Wellness Practices',
  'Information Technology / Professional Services',
  'Manufacturing (Skilled Labor)',
  'Professional Services',
  'Recruiters',
  'Roofing & General Construction',
  'Skilled Labor',
  'Transportation & Logistics',
  'Utilities & Energy Infrastructure'
];

const GOALL_AUTOMATION_TAG_ORDER = new Map(GOALL_AUTOMATION_TAGS.map((tag,i)=>[tag,i]));
const GOALL_TAG_CONFIDENCE_RANK = {high:3, medium:2, low:1};

function rawGoallIndustry(p={}){
  return String(p.rawIndustry||p.raw_industry||p.aiExactIndustry||p.ai_exact_industry||p.exactIndustry||p.industry||p.organizationType||p.primaryService||p.cause||'').trim();
}

function goallAutomationText(p={}){
  return normalizeLeadIndustryText([
    rawGoallIndustry(p),
    p.normalizedIndustry,
    p.primaryService,
    p.organizationType,
    p.companyDescription,
    p.googleRaw,
    p.googleData,
    p.operationalIndicators,
    Array.isArray(p.evidenceSignals)?p.evidenceSignals.join(' '):p.evidenceSignals
  ].filter(Boolean).join(' '));
}

function goallAutomationResult(tag,confidence,reason,p={},opts={}){
  const rawIndustry=rawGoallIndustry(p) || 'unclear';
  return {
    automationTag:tag,
    automationTagReason:reason,
    normalizedIndustry:opts.normalizedIndustry || tag || 'unclear',
    rawIndustry,
    tagConfidence:confidence,
    needsNewAutomation:!!opts.needsNewAutomation,
    suggestedNewAutomationTag:opts.suggestedNewAutomationTag || ''
  };
}

function mapGoallAutomationTag(p={}){
  if((p.leadProfile||'').toLowerCase()==='westwood') return {};
  if(p.automationTag && GOALL_AUTOMATION_TAG_ORDER.has(p.automationTag)){
    return goallAutomationResult(
      p.automationTag,
      String(p.tagConfidence||'high').toLowerCase(),
      p.automationTagReason||`Already classified as ${p.automationTag}.`,
      p,
      {
        normalizedIndustry:p.normalizedIndustry||p.automationTag,
        needsNewAutomation:p.needsNewAutomation===true || String(p.needsNewAutomation).toLowerCase()==='true',
        suggestedNewAutomationTag:p.suggestedNewAutomationTag||''
      }
    );
  }
  const direct=normalizeLeadIndustryText([p.organizationType,p.aiExactIndustry,p.ai_exact_industry,p.industry,p.cause].filter(Boolean).join(' '));
  if(/\bplumb/.test(direct)){
    return goallAutomationResult('Home Services','high','Plumbing search or industry signal was found.',p,{normalizedIndustry:'plumbing services'});
  }
  if(/\bhvac|heating|cooling|air conditioning/.test(direct)){
    return goallAutomationResult('HVAC','high','HVAC search or industry signal was found.',p,{normalizedIndustry:'HVAC services'});
  }
  if(/\belectric|electrical/.test(direct)){
    return goallAutomationResult('Electrical Contractors','high','Electrical search or industry signal was found.',p,{normalizedIndustry:'electrical services'});
  }
  if(/\broof/.test(direct)){
    return goallAutomationResult('Roofing & General Construction','high','Roofing search or industry signal was found.',p,{normalizedIndustry:'roofing services'});
  }
  const text=goallAutomationText(p);
  if(!text) return goallAutomationResult('', 'low', 'No industry signal was available, so no automation tag could be assigned.', p, {needsNewAutomation:true, suggestedNewAutomationTag:'Manual Review'});

  if(/\b(electrician|electricians|electrical|electrical contractor|lighting|low voltage|generator|generators)\b/.test(text)){
    return goallAutomationResult('Electrical Contractors','high','Electrical trade signals were found.',p,{normalizedIndustry:'electrical services'});
  }
  if(/\b(hvac|heating|cooling|air conditioning|a\/c|ac repair|furnace|refrigeration|mechanical contractor|mechanical contractors)\b/.test(text)){
    return goallAutomationResult('HVAC','high','HVAC, heating, cooling, refrigeration, or mechanical contractor signals were found.',p,{normalizedIndustry:'HVAC services'});
  }
  if(/\b(roof|roofing|roofer|roof repair|gutter|gutters)\b/.test(text)){
    return goallAutomationResult('Roofing & General Construction','high','Roofing or adjacent gutter service signals were found.',p,{normalizedIndustry:'roofing services'});
  }
  if(/\b(solar|energy|utility|utilities|power|renewable|battery|ev charging|electric vehicle charging)\b/.test(text)){
    return goallAutomationResult('Utilities & Energy Infrastructure','high','Energy, utility, renewable, battery, or EV charging signals were found.',p,{normalizedIndustry:'energy and utilities'});
  }
  if(/\b(manufactur\w*|industrial supplier|food production|packaging|metal manufacturing|production facilit\w*|assembly|factory)\b/.test(text)){
    return goallAutomationResult('Manufacturing (Skilled Labor)','high','Manufacturing, production, assembly, packaging, or industrial supplier signals were found.',p,{normalizedIndustry:'manufacturing'});
  }
  if(/\b(staffing|recruiter|recruiting|employment agency|temp agency|temporary staffing|workforce placement|talent agency)\b/.test(text)){
    return goallAutomationResult('Recruiters','high','Staffing, recruiting, employment, or workforce placement signals were found.',p,{normalizedIndustry:'staffing and recruiting'});
  }
  if(/\b(hr consulting|human resources|payroll|benefits broker|benefits consultant|benefit consultant|peo\b|workforce consulting|organizational development|organisation development)\b/.test(text)){
    return goallAutomationResult('Information Technology / Professional Services','high','HR, payroll, benefits, PEO, or workforce consulting signals were found.',p,{normalizedIndustry:'HR and workforce services'});
  }
  if(/\b(hotel|resort|restaurant|catering|event venue|hospitality|tourism|lodging)\b/.test(text)){
    return goallAutomationResult('Hospitality / High-End Food Service','high','Hotel, restaurant, catering, event, lodging, tourism, or hospitality signals were found.',p,{normalizedIndustry:'hospitality'});
  }
  if(/\b(private school|school|training|tutoring|educational service|education service|childcare|child care|daycare|learning center|trade school)\b/.test(text)){
    return goallAutomationResult('Education & Skilled Vocational Training','high','Private education, training, childcare, tutoring, learning center, or trade school signals were found.',p,{normalizedIndustry:'education'});
  }
  if(/\b(plumb\w*|landscap\w*|pest|garage door|restoration|flooring|painting|remodel\w*|appliance repair|pool service|cleaning|home repair|home service|home services|lawn care|janitorial|carpet clean\w*|window clean\w*)\b/.test(text)){
    return goallAutomationResult('Home Services','high','Home service signals were found.',p,{normalizedIndustry:'home services'});
  }
  if(/\b(welding|fabrication|concrete|excavat|general contractor|construction|machine shop|heavy equipment|diesel|auto repair|fleet maintenance|towing|moving|delivery|trade business|trades business|mechanic|body shop|collision|masonry|warehouse|logistics|freight|courier|trucking|transportation)\b/.test(text)){
    const logistics=/\b(trucking|logistics|freight|courier|transportation)\b/.test(text);
    return goallAutomationResult(logistics?'Transportation & Logistics':'Skilled Labor',logistics?'high':'high',logistics?'Transportation or logistics signals were found.':'Skilled trade, construction, repair, equipment, or field service signals were found.',p,{
      normalizedIndustry:logistics?'transportation and logistics':'skilled labor',
      needsNewAutomation:false,
      suggestedNewAutomationTag:''
    });
  }
  if(/\b(chiropract\w*|medical|dental|dentist|optometry|physical therapy|pt clinic|med spa|spa|clinic|wellness|healthcare|health care)\b/.test(text)){
    if(/\b(dental|dentist|orthodont|periodont|endodont|oral surgery|prosthodont)\b/.test(text)){
      return goallAutomationResult('Dentistry & Dental Practices','high','Dental practice signals were found.',p,{normalizedIndustry:'dentistry'});
    }
    return goallAutomationResult('Healthcare & Wellness Practices','high','Healthcare or wellness practice signals were found.',p,{normalizedIndustry:'healthcare and wellness'});
  }
  if(/\b(law office|law firm|lawyer|attorney|legal|accounting|cpa|financial advisor|financial advisory|insurance|real estate|mortgage|architecture|engineering|it service|managed service provider|msp\b|technology service)\b/.test(text)){
    if(/\b(it service|managed service provider|msp\b|technology service)\b/.test(text)){
      return goallAutomationResult('Information Technology / Professional Services','high','Information technology or managed service signals were found.',p,{normalizedIndustry:'information technology services'});
    }
    return goallAutomationResult('Professional Services','high','Professional service signals were found.',p,{normalizedIndustry:'professional services'});
  }
  return goallAutomationResult('Professional Services','low','No exact automation match was found, so this is routed to Professional Services for review until a better automation exists.',p,{normalizedIndustry:rawGoallIndustry(p)||'unclear',needsNewAutomation:true,suggestedNewAutomationTag:'Manual Review'});
}

function applyGoallAutomationTag(p={}){
  if((p.leadProfile||'').toLowerCase()==='westwood') return p;
  return {...p,...mapGoallAutomationTag(p)};
}

function summarizeGoallAutomationTags(leads=[]){
  const tagCounts=Object.fromEntries(GOALL_AUTOMATION_TAGS.map(tag=>[tag,0]));
  const suggestedCounts={};
  for(const lead of leads||[]){
    const mapped=mapGoallAutomationTag(lead);
    if(mapped.automationTag && Object.prototype.hasOwnProperty.call(tagCounts,mapped.automationTag)) tagCounts[mapped.automationTag]+=1;
    if(mapped.needsNewAutomation && mapped.suggestedNewAutomationTag){
      suggestedCounts[mapped.suggestedNewAutomationTag]=(suggestedCounts[mapped.suggestedNewAutomationTag]||0)+1;
    }
  }
  return {tagCounts,suggestedCounts};
}

function leadNameFromOpportunity(o={}){
  return o.contact?.companyName || o.contact?.businessName || o.companyName || o.businessName || o.contact?.name || o.contactName || o.name || '';
}

function leadContactSnapshot(o={}){
  return {
    opportunityId:o.id||'',
    contactId:o.contact?.id||o.contactId||'',
    name:leadNameFromOpportunity(o),
    contactName:o.contact?.name||o.contactName||'',
    email:o.contact?.email||o.email||'',
    phone:o.contact?.phone||o.phone||'',
    owner:inferValOwner(o),
    stage:o.pipelineStage?.name||o.stage?.name||o.stageName||o.pipelineStage||'',
    value:o.monetaryValue||o.value||''
  };
}

function extractJsonArray(text){
  const raw=String(text||'').trim();
  try{
    const parsed=JSON.parse(raw);
    if(Array.isArray(parsed)) return parsed;
    if(Array.isArray(parsed.leads)) return parsed.leads;
    if(Array.isArray(parsed.prospects)) return parsed.prospects;
  }catch(_){}
  const match=raw.match(/\[[\s\S]*\]/);
  if(!match) return [];
  try{return JSON.parse(match[0]);}catch(_){return [];}
}

function donorValue(v){
  const n=Number(String(v||'').replace(/[^0-9.]/g,''));
  if(!Number.isFinite(n)||n<=0) return 0;
  return Math.round(n);
}

function leadLimitValue(v){
  const n=Number(String(v||'').replace(/[^0-9]/g,''));
  if(!Number.isFinite(n)||n<=0) return 12;
  return Math.min(Math.round(n), GOALL_LEAD_SEARCH_MAX);
}

function normalizeLeadIndustryText(value){
  return String(value||'')
    .toLowerCase()
    .replace(/&/g,' and ')
    .replace(/[^a-z0-9\s/-]/g,' ')
    .replace(/\s+/g,' ')
    .trim();
}

const GOALL_INDUSTRY_ALIASES = [
  [/truck|transport|freight|carrier|fleet/, 'trucking companies'],
  [/construction|builder|builders/, 'construction companies'],
  [/\bgeneral contractors?\b/, 'general contractors'],
  [/electric|electrical/, 'electrical contractors'],
  [/plumb/, 'plumbing companies'],
  [/\bhvac\b|heating|air conditioning/, 'HVAC companies'],
  [/roof/, 'roofing companies'],
  [/weld|welder/, 'welding companies'],
  [/concrete|masonry/, 'concrete contractors'],
  [/landscap|lawn care/, 'landscaping companies'],
  [/restoration|remediation|water damage/, 'restoration companies'],
  [/solar/, 'solar installers'],
  [/manufactur|factory|industrial/, 'manufacturing companies'],
  [/machine shop|machining|cnc/, 'machine shops'],
  [/metal fabricat|fabrication/, 'metal fabrication companies'],
  [/logistics|warehouse|warehousing|distribution/, 'logistics companies'],
  [/staffing|recruit/, 'staffing agencies'],
  [/home care|senior care|in-home care/, 'home care agencies'],
  [/medical practice|medical office|doctor|physician|clinic/, 'medical practices'],
  [/dental|dentist/, 'dental offices'],
  [/chiropract/, 'chiropractic offices'],
  [/physical therap|pt clinic/, 'physical therapy clinics'],
  [/behavioral health|mental health|counseling/, 'behavioral health clinics'],
  [/veterinary|veterinarian|animal hospital/, 'veterinary clinics'],
  [/law office|law firm|attorney|legal/, 'law offices'],
  [/accounting|cpa|bookkeeping/, 'accounting firms'],
  [/wealth|financial advisor|financial planning/, 'wealth management firms'],
  [/insurance/, 'insurance agencies'],
  [/marketing|advertising|creative agency/, 'marketing agencies'],
  [/consulting|consultant/, 'consulting firms'],
  [/engineering/, 'engineering firms'],
  [/architect/, 'architecture firms'],
  [/auto repair|mechanic|automotive repair/, 'auto repair shops'],
  [/collision|body shop|auto body/, 'collision centers'],
  [/equipment rental|heavy equipment/, 'equipment rental companies'],
  [/commercial cleaning|janitorial/, 'commercial cleaning companies'],
  [/security guard|security company/, 'security companies'],
  [/property management/, 'property management companies'],
  [/commercial real estate/, 'commercial real estate firms'],
  [/restaurant|hospitality/, 'restaurants'],
  [/catering/, 'catering companies'],
  [/hotel|lodging/, 'hotels'],
  [/fitness|gym|studio/, 'fitness centers'],
  [/private school|school/, 'private schools'],
  [/childcare|daycare|child care/, 'childcare centers']
];

function extractGoallIndustries(text){
  const raw=normalizeLeadIndustryText(text);
  if(!raw) return [];
  const found=[];
  for(const industry of GOALL_PRIORITY_INDUSTRIES_ARIZONA){
    const base=normalizeLeadIndustryText(industry).replace(/\b(companies|contractors|offices|firms|agencies|clinics|centers|shops|installers|practices)\b/g,'').trim();
    if(base && raw.includes(base)) found.push(industry);
  }
  for(const [pattern,industry] of GOALL_INDUSTRY_ALIASES){
    if(pattern.test(raw)) found.push(industry);
  }
  return [...new Set(found)];
}

function extractWestwoodIndustries(text){
  const raw=normalizeLeadIndustryText(text);
  if(!raw) return [];
  const found=[];
  for(const industry of WESTWOOD_PRIORITY_INDUSTRIES){
    const base=normalizeLeadIndustryText(industry).replace(/\b(companies|firms|agencies|practices|offices|clinics|providers|groups|businesses|brokerages)\b/g,'').trim();
    if(base && raw.includes(base)) found.push(industry);
  }
  for(const [pattern,industry] of GOALL_INDUSTRY_ALIASES){
    if(pattern.test(raw)) found.push(industry);
  }
  if(/\bsaas|software\b/.test(raw)) found.push('SaaS companies');
  if(/\btechnology|tech\b/.test(raw)) found.push('technology companies');
  if(/\bmanaged it|msp\b/.test(raw)) found.push('managed IT service providers');
  if(/\bfamily owned|family-owned\b/.test(raw)) found.push('family-owned businesses');
  if(/\bleadership team|leadership development|team development|executive growth\b/.test(raw)) found.push('companies with leadership teams');
  return [...new Set(found)];
}

function isWestwoodLeadProfile(body={}){
  if(VAL_LEAD_PROFILE==='goall') return false;
  if(VAL_LEAD_PROFILE==='westwood') return true;
  if(WESTWOOD_LEAD_PROFILE_ENABLED) return true;
  const explicit=normalizeLeadIndustryText([
    body.leadProfile,
    body.profile,
    body.project,
    body.brand,
    body.client
  ].filter(Boolean).join(' '));
  if(/\bgoall\b/.test(explicit)) return false;
  if(/\bwestwood\b/.test(explicit)) return true;
  const clientIdentity=normalizeLeadIndustryText([
    CLIENT_CONFIG.clientName,
    CLIENT_CONFIG.clientSlug,
    CLIENT_CONFIG.brandName,
    CLIENT_CONFIG.projectName,
    CLIENT_CONFIG.projectType
  ].filter(Boolean).join(' '));
  return /\bwestwood\b/.test(clientIdentity);
}

function wantsAllGoallIndustries(text){
  const raw=normalizeLeadIndustryText(text);
  if(!raw) return false;
  return /\b(all|priority|preset|higher income|high income|goall fit|goall-fit|best fit|businesses|companies|employers)\b/.test(raw)
    && !extractGoallIndustries(raw).length;
}

function normalizeGoallMarket(value,criteria='',profile='goall'){
  const raw=String(value||'').trim();
  const rawNorm=normalizeLeadIndustryText(raw);
  if(raw){
    const city=GOALL_ARIZONA_CITIES.find(c=>rawNorm.includes(normalizeLeadIndustryText(c)));
    if(city) return /\baz\b|\barizona\b/i.test(raw) ? raw : `${city}, Arizona`;
    if(/,/.test(raw)) return raw;
  }
  const combined=normalizeLeadIndustryText(`${raw} ${criteria}`);
  const combinedCity=GOALL_ARIZONA_CITIES.find(c=>combined.includes(normalizeLeadIndustryText(c)));
  if(combinedCity) return `${combinedCity}, Arizona`;
  if(/\baz\b|\barizona\b/.test(combined)) return 'Arizona';
  if(/\bid\b|\bidaho\b/.test(combined)) return 'Idaho, US';
  return raw || (profile==='westwood'?'Idaho, US':'Arizona');
}

function resolveGoallLeadSearchPlan(body={}){
  const leadProfile=isWestwoodLeadProfile(body)?'westwood':'goall';
  const criteria=String(body.criteria||body.query||'').trim();
  const organizationType=String(body.organizationType||body.type||body.industry||'').trim();
  const industryInput=Array.isArray(body.industries)?body.industries.join(', '):String(body.industries||'').trim();
  const combined=[industryInput,organizationType,criteria].filter(Boolean).join(' ');
  const explicitIndustries=leadProfile==='westwood'?extractWestwoodIndustries(combined):extractGoallIndustries(combined);
  const mode=normalizeLeadIndustryText(body.searchMode||body.mode||'');
  const allPriority=leadProfile==='westwood'
    ? (mode.includes('all') || /\bwestwood|priority|leadership development|private businesses|businesses|companies\b/i.test(combined||'businesses')) && !explicitIndustries.length
    : mode.includes('all') || wantsAllGoallIndustries(combined) || (!explicitIndustries.length && /business|company|employer|goall|higher/i.test(combined||'businesses'));
  const industries=allPriority
    ? (leadProfile==='westwood'?WESTWOOD_PRIORITY_INDUSTRIES:GOALL_PRIORITY_INDUSTRIES_ARIZONA)
    : (explicitIndustries.length?explicitIndustries:[organizationType||'businesses']);
  const market=normalizeGoallMarket(body.market||body.location||body.cityState||'',combined,leadProfile);
  const employeeMinimum=donorValue(body.employeeMinimum||body.minimumEmployees||body.employees)||(leadProfile==='westwood'?25:GOALL_COMPANY_EMPLOYEE_MINIMUM);
  const limit=leadLimitValue(body.limit);
  const organizationLabel=allPriority
    ? (leadProfile==='westwood'?'Westwood priority industries':'GOALL priority industries')
    : industries.join(', ');
  const defaultCriteria=leadProfile==='westwood'
    ? `${organizationLabel} non-government, non-municipal private businesses in ${market} with likely leadership teams`
    : `${organizationLabel} with at least ${employeeMinimum} employees`;
  return {
    criteria:criteria || defaultCriteria,
    requestedViableLeads:limit,
    market,
    employeeMinimum,
    industries:[...new Set(industries)],
    allPriority,
    organizationType:organizationLabel,
    tag:leadProfile==='westwood'?'limitless_enrich':normalizeLeadTag(body.tag||(!allPriority&&industries.length===1?industries[0]:'goall priority')),
    cities:leadProfile==='westwood'&&/\bidaho\b/i.test(market)?WESTWOOD_IDAHO_CITIES:(/\barizona\b/i.test(market)?GOALL_ARIZONA_CITIES:[]),
    fastSearch:/^(1|true|yes)$/i.test(String(body.fastSearch||body.fast_search||'')),
    leadProfile,
    leadBrand:leadProfile==='westwood'?'Westwood':'GOALL'
  };
}

function goallLeadKey(p={}){
  const email=String(p.email||'').toLowerCase().trim();
  const phone=String(p.phone||'').replace(/\D/g,'');
  const website=String(p.website||'').toLowerCase().replace(/^https?:\/\/(www\.)?/,'').replace(/\/$/,'').trim();
  if(email) return `email:${email}`;
  if(phone) return `phone:${phone}`;
  if(website) return `site:${website}`;
  return `name:${normalizeLeadIndustryText(p.organizationName||p.name)}|${normalizeLeadIndustryText(p.city||p.location)}|${normalizeLeadIndustryText(p.state)}`;
}

function reviewCountFromLead(p={}){
  const text=[p.googleRaw, p.donorEstimateBasis, p.employeeEstimateBasis, Array.isArray(p.evidenceSignals)?p.evidenceSignals.join(' '):p.evidenceSignals].filter(Boolean).join(' ');
  const m=String(text).match(/(\d{1,6})\s+(?:google\s+)?reviews?/i);
  return m?Number(m[1]):0;
}

function scoreGoallFit(p={}){
  const industry=String(p.aiExactIndustry||p.industry||p.organizationType||p.cause||'').toLowerCase();
  const text=[industry,p.organizationType,p.primaryService,p.operationalIndicators,p.donorEstimateBasis,p.employeeEstimateBasis,Array.isArray(p.evidenceSignals)?p.evidenceSignals.join(' '):p.evidenceSignals].filter(Boolean).join(' ').toLowerCase();
  const intel=buildGoallIntelligenceProfile(p,industry||'business');
  const signalText=[text,intel.signals.growth,intel.signals.workforce,intel.signals.engagement,intel.employee.note].join(' ').toLowerCase();
  let score=45;
  const preferred=/trucking|construction|electrical|hvac|plumbing|law|chiropractic|medical|manufactur|staffing|professional|home care|roof|weld|logistics|dental|insurance|accounting/.test(text);
  if(preferred) score+=18;
  if(p.website) score+=8;
  if(validEmail(p.email)) score+=8;
  if(validPhone(p.phone)) score+=8;
  if(p.decisionMakerName||p.decisionMakerTitle) score+=8;
  if(/multiple|locations|fleet|dispatch|crew|staff|team|hiring|careers|warehouse|service teams|employees/.test(signalText)) score+=10;
  if(intel.employee.count) score+=8;
  if(/hiring|job postings?|careers|technicians?|recruit|staffing|short.?staffed|turnover|burnout|scheduling|overwhelmed/.test(signalText)) score+=8;
  if(/expanded|expansion|new location|opened|opening|new office|new market|contract|award|fastest growing|best places to work/.test(signalText)) score+=8;
  if(/linkedin|post|announcement|community|news|active website|google reviews?/.test(signalText)) score+=5;
  const reviews=reviewCountFromLead(p);
  if(reviews>=100) score+=8;
  else if(reviews>=25) score+=5;
  if(/solo|sole proprietor|unclear|weak|missing website|no website/.test(String(p.weakFitConcerns||'').toLowerCase())) score-=12;
  score=Math.max(0,Math.min(100,score));
  const reasons=[
    preferred?'priority GOALL industry':'general business fit',
    p.website?'active website':'website unclear',
    validEmail(p.email)||validPhone(p.phone)?'reachable contact path':'no reachable contact path',
    intel.employee.count?`employee estimate ${intel.employee.count}`:'employee count unclear',
    intel.signals.growth && !/^No specific/i.test(intel.signals.growth)?'growth signal found':'',
    intel.signals.workforce && !/^No clear/i.test(intel.signals.workforce)?'workforce signal found':'',
    reviews?`${reviews} Google reviews`:'',
    p.decisionMakerName||p.decisionMakerTitle?'decision-maker signal':''
  ].filter(Boolean).join('; ');
  return {goallFitScore:score,goallFitReason:reasons};
}

function leadScoreFromGoallFit(p={}){
  const fit=Number(p.goallFitScore||0);
  const c=leadContactability(p);
  const industryText=String([p.aiExactIndustry,p.industry,p.organizationType,p.primaryService,p.cause].filter(Boolean).join(' ')).toLowerCase();
  const signalText=String([p.operationalIndicators,p.donorEstimateBasis,p.employeeEstimateBasis,p.growthActivity,p.hiringActivity,p.careersPage,p.goallFitReason,Array.isArray(p.evidenceSignals)?p.evidenceSignals.join(' '):p.evidenceSignals].filter(Boolean).join(' ')).toLowerCase();
  const intel=buildGoallIntelligenceProfile(p,industryText||'business');
  const employeeCount=donorValue(intel.employee.numeric)||employeeEstimateMinimum(intel.employee.count);
  const highestIndustries=/trucking|hvac|plumbing|electrical|welding|construction|roofing|manufactur|law office|chiropractic|medical|dental|staffing|home care|logistics|commercial cleaning|security|fire protection/.test(industryText);
  const alignedIndustries=highestIndustries || /accounting|insurance|wealth|engineering|architecture|property management|auto repair|collision|equipment rental|physical therapy|behavioral health|veterinary/.test(industryText);
  const employeeSignals=!!intel.employee.count || /10\+|employees|staff|team|crew|fleet|dispatch|payroll|benefit|multiple locations|hiring|careers|warehouse|commercial|field teams|service teams/.test(signalText);
  const decisionMakerFound=!!(p.decisionMakerName||p.linkedinPersonalUrl);
  const strongContact=c.contactabilityStatus==='full_contactability';
  const reachable=!!(c.hasEmail||c.hasPhone);
  const strongActivity=employeeSignals || reviewCountFromLead(p)>=100 || /multiple locations|hiring|careers|commercial|fleet|dispatch|crew|team/.test(signalText) || !/^No specific/i.test(intel.signals.growth) || !/^No clear/i.test(intel.signals.workforce);
  const weakSignals=/solo|sole proprietor|one person|very small|weak|unclear|missing website|no website|low-fit|low fit/.test(signalText);
  let leadScore=3;
  let leadScoreReason='Score 3 because the business appears relevant, but decision-maker, employee-size, or contact evidence is incomplete.';
  if(highestIndustries && decisionMakerFound && strongContact && strongActivity && fit>=78 && (employeeSignals || employeeCount>=10)){
    leadScore=1;
    leadScoreReason='Score 1 because the business is strongly GOALL-aligned, has a verified decision-maker signal, full contactability, and meaningful employee, growth, hiring, or workforce evidence.';
  }else if(highestIndustries && reachable && fit>=65){
    leadScore=2;
    leadScoreReason='Score 2 because the business is strongly aligned and reachable, but decision-maker, employee-size, or workforce evidence still needs confirmation.';
  }else if(alignedIndustries && reachable && fit>=58){
    leadScore=2;
    leadScoreReason='Score 2 because the business is in an aligned industry and appears active, but full contactability, decision-maker, employee-size, or workforce evidence is not fully verified.';
  }else if(fit>=48 && !weakSignals){
    leadScore=3;
    leadScoreReason='Score 3 because the business may fit GOALL, but the current evidence is incomplete.';
  }else{
    leadScore=4;
    leadScoreReason='Score 4 because the business appears small or low-fit for GOALL based on limited evidence of employees or benefit needs.';
  }
  if(c.contactabilityStatus==='phone_only' && leadScore<=2){
    leadScoreReason += ' It is phone-only, so it should use phone-first outreach.';
  }else if(c.contactabilityStatus==='not_contactable'){
    leadScore=Math.max(leadScore,3);
    leadScoreReason += ' No usable email or phone was found, so the lead is visible in CRM but not outreach-ready.';
  }
  return {leadScore,leadScoreReason};
}

function applyGoallLeadScoring(p={}){
  const fit=p.goallFitScore?{goallFitScore:p.goallFitScore,goallFitReason:p.goallFitReason}:scoreGoallFit(p);
  const scored={...p,...fit};
  const leadScore=Number(p.leadScore||p.lead_score||0);
  const leadScoreReason=String(p.leadScoreReason||p.lead_score_reason||'').trim();
  if(leadScore>=1 && leadScore<=4 && leadScoreReason){
    return {...scored,leadScore,lead_score:leadScore,leadScoreReason,lead_score_reason:leadScoreReason};
  }
  const computed=leadScoreFromGoallFit(scored);
  return {...scored,...computed,lead_score:computed.leadScore,lead_score_reason:computed.leadScoreReason};
}

function leadScoreFromWestwoodFit(p={}){
  const fit=Number(p.goallFitScore||0);
  const c=leadContactability(p);
  if(!c.importable) return {leadScore:4,leadScoreReason:'Lead is not viable because no email or phone number was available.'};
  const text=String([
    p.aiExactIndustry,p.industry,p.organizationType,p.primaryService,p.operationalIndicators,
    p.donorEstimateBasis,p.employeeEstimateBasis,p.growthActivity,p.hiringActivity,p.careersPage,
    p.goallFitReason,Array.isArray(p.evidenceSignals)?p.evidenceSignals.join(' '):p.evidenceSignals
  ].filter(Boolean).join(' ')).toLowerCase();
  const strongIndustry=/manufactur|construction|engineering|architecture|professional service|law|accounting|cpa|financial|insurance|healthcare|chiropractic|dental|physical therapy|staffing|logistics|trucking|technology|saas|managed it|marketing|consulting|real estate|property management|home care|hospitality|multi-location|family-owned|leadership team/.test(text);
  const leadershipComplexity=/25\+|employees|leadership|management|manager|department|team|culture|hiring|expansion|growth|new location|multiple locations|merger|acquisition|executive|appointed|promoted|awards|operations/.test(text);
  const privateFit=!/government|municipal|city of|county|public department|public school|church|nonprofit|non-profit/.test(text);
  const weak=/solo|sole proprietor|one person|very small|inactive|closed|weak|no website|missing website|public school|municipal|government/.test(text);
  let leadScore=3;
  let leadScoreReason='Score 3 because the business is contactable and somewhat aligned, but employee count, leadership team complexity, or organizational development need is unclear.';
  if(privateFit && strongIndustry && leadershipComplexity && fit>=70){
    leadScore=1;
    leadScoreReason='Score 1 because this is a private company with likely leadership-team complexity, employee base, and strong fit for Westwood leadership and team development services.';
  }else if(privateFit && strongIndustry && fit>=58){
    leadScore=2;
    leadScoreReason='Score 2 because this appears to be an active private business in an aligned industry, but employee count, growth signals, or leadership complexity are not fully verified.';
  }else if(privateFit && !weak && fit>=45){
    leadScore=3;
    leadScoreReason='Score 3 because the business is contactable and may fit Westwood, but there is limited evidence of leadership team complexity or organizational growth needs.';
  }else{
    leadScore=4;
    leadScoreReason='Score 4 because the business appears small, weakly aligned, or has limited evidence of employees, leadership complexity, or active business needs.';
  }
  if(c.contactabilityStatus==='phone_only' && leadScore<=2){
    leadScoreReason += ' It is phone-only, but lack of email does not lower the score because the company fit is strong.';
  }
  return {leadScore,leadScoreReason};
}

function applyLeadScoring(p={}){
  if((p.leadProfile||'').toLowerCase()==='westwood'){
    const fit=p.goallFitScore?{goallFitScore:p.goallFitScore,goallFitReason:p.goallFitReason}:scoreGoallFit(p);
    const scored={...p,...fit};
    const leadScore=Number(p.leadScore||p.lead_score||0);
    const leadScoreReason=String(p.leadScoreReason||p.lead_score_reason||'').trim();
    if(leadScore>=1 && leadScore<=4 && leadScoreReason){
      return {...scored,leadScore,lead_score:leadScore,leadScoreReason,lead_score_reason:leadScoreReason};
    }
    const computed=leadScoreFromWestwoodFit(scored);
    return {...scored,...computed,lead_score:computed.leadScore,lead_score_reason:computed.leadScoreReason};
  }
  return applyGoallAutomationTag(applyGoallLeadScoring(p));
}

function contactabilityRank(p={}){
  const status=leadContactability(p).contactabilityStatus;
  if(status==='full_contactability') return 1;
  if(status==='email_only') return 2;
  if(status==='phone_only') return 3;
  return 4;
}

function sortGoallLeads(a,b){
  const scoreA=Number(a.leadScore||a.lead_score||4);
  const scoreB=Number(b.leadScore||b.lead_score||4);
  if(scoreA!==scoreB) return scoreA-scoreB;
  const mappedA=mapGoallAutomationTag(a);
  const mappedB=mapGoallAutomationTag(b);
  const tagOrderA=GOALL_AUTOMATION_TAG_ORDER.has(mappedA.automationTag)?GOALL_AUTOMATION_TAG_ORDER.get(mappedA.automationTag):99;
  const tagOrderB=GOALL_AUTOMATION_TAG_ORDER.has(mappedB.automationTag)?GOALL_AUTOMATION_TAG_ORDER.get(mappedB.automationTag):99;
  const tagDelta=tagOrderA-tagOrderB;
  if(tagDelta) return tagDelta;
  const confidenceDelta=(GOALL_TAG_CONFIDENCE_RANK[mappedB.tagConfidence]||0)-(GOALL_TAG_CONFIDENCE_RANK[mappedA.tagConfidence]||0);
  if(confidenceDelta) return confidenceDelta;
  const contactDelta=contactabilityRank(a)-contactabilityRank(b);
  if(contactDelta) return contactDelta;
  return (Number(b.goallFitScore)||0)-(Number(a.goallFitScore)||0);
}

function summarizeGoallDiscovery({requested,leads,rawCount,industries,cities,rejectedReasons}){
  const counts={fullContactability:0,emailOnly:0,phoneOnly:0,noContact:0,rejected:0,score1Count:0,score2Count:0,score3Count:0,score4Count:0};
  for(const lead of leads||[]){
    const c=leadContactability(lead);
    if(c.contactabilityStatus==='full_contactability') counts.fullContactability+=1;
    else if(c.contactabilityStatus==='email_only') counts.emailOnly+=1;
    else if(c.contactabilityStatus==='phone_only') counts.phoneOnly+=1;
    else counts.noContact+=1;
    const score=Number(lead.leadScore||lead.lead_score||0);
    if(score===1) counts.score1Count+=1;
    else if(score===2) counts.score2Count+=1;
    else if(score===3) counts.score3Count+=1;
    else if(score===4) counts.score4Count+=1;
  }
  counts.rejected=Object.values(rejectedReasons||{}).reduce((sum,n)=>sum+n,0);
  return {
    requestedViableLeads:requested,
    viableLeadsFound:(leads||[]).length,
    rawBusinessesSearched:rawCount||0,
    industriesSearched:industries||[],
    citiesSearched:cities||[],
    fullContactability:counts.fullContactability,
    emailOnly:counts.emailOnly,
    phoneOnly:counts.phoneOnly,
    noContact:counts.noContact,
    score1Count:counts.score1Count,
    score2Count:counts.score2Count,
    score3Count:counts.score3Count,
    score4Count:counts.score4Count,
    rejected:counts.rejected,
    rejectedReasons:rejectedReasons||{},
    pipelineMinimum:GOALL_PIPELINE_MINIMUM,
    pipelineVolumeStatus:(leads||[]).length>=GOALL_PIPELINE_MINIMUM?'sufficient':'insufficient',
    pipelineVolumeWarning:(leads||[]).length>=GOALL_PIPELINE_MINIMUM?'':`GOALL pipeline volume is insufficient. Fewer than ${GOALL_PIPELINE_MINIMUM} people/prospects is not enough; treat this as a batch toward the minimum, not a complete pipeline.`
  };
}

function normalizeCountryCode(value){
  const raw=String(value||'').trim();
  if(!raw) return undefined;
  const lower=raw.toLowerCase();
  const map={
    'united states':'US',
    'united states of america':'US',
    'usa':'US',
    'us':'US',
    'canada':'CA',
    'ca':'CA',
    'united kingdom':'GB',
    'uk':'GB',
    'great britain':'GB',
    'australia':'AU'
  };
  if(map[lower]) return map[lower];
  if(/^[A-Z]{2}$/.test(raw)) return raw;
  return undefined;
}

function safeLeadString(value){
  if(value===undefined || value===null) return '';
  if(typeof value==='string') return value.trim();
  if(Array.isArray(value)) return value.filter(Boolean).map(v=>typeof v==='string'?v:JSON.stringify(v)).join('\n');
  if(typeof value==='object') return JSON.stringify(value);
  return String(value);
}

function parseLeadJson(value){
  if(!value) return {};
  if(typeof value==='object') return value;
  try{return JSON.parse(String(value));}catch(_){return {};}
}

function leadDomain(value){
  try{
    const url=new URL(String(value||'').startsWith('http')?String(value):`https://${value}`);
    return url.hostname.replace(/^www\./,'');
  }catch(_){
    return '';
  }
}

function leadArrayText(value){
  if(Array.isArray(value)) return value.filter(Boolean).map(v=>String(v).trim()).filter(Boolean).join('; ');
  return String(value||'').trim();
}

function firstLeadValue(...values){
  for(const value of values){
    const text=leadArrayText(value);
    if(text && !/^(unknown|unclear|none|null|undefined|n\/a)$/i.test(text)) return text;
  }
  return '';
}

function employeeCountBand(n){
  const value=Number(n)||0;
  if(value>=500) return '500+';
  if(value>=250) return '250-499';
  if(value>=100) return '100-249';
  if(value>=50) return '50-99';
  if(value>=25) return '25-49';
  if(value>=10) return '10-24';
  if(value>0) return '1-9';
  return '';
}

function employeeEstimateMinimum(value){
  const raw=String(value||'');
  const range=raw.match(/\b(\d{1,5})\s*(?:-|to|–)\s*(\d{1,5})\b/);
  if(range) return Number(range[1])||0;
  const plus=raw.match(/\b(\d{1,5})\s*\+\b/);
  if(plus) return Number(plus[1])||0;
  return donorValue(raw);
}

function goallEmployeeEstimate(p={}){
  const rawEmployeeValue=firstLeadValue(
    p.estimatedEmployeeCount,
    p.estimated_employee_count,
    p.scrapedNumberOfEmployees,
    p.scraped_number_of_employees,
    p.employeeCount,
    p.employees,
    p.linkedinEmployeeCount,
    p.linkedin_employee_count,
    p.linkedinCompanyEmployeeCount,
    p.approximateDonors,
    p.estimatedDonors,
    p.donorCount
  );
  const rangeMatch=String(rawEmployeeValue||'').match(/\b(\d{1,5})\s*(?:-|to|–)\s*(\d{1,5})\b|\b(\d{1,5})\s*\+\b/);
  const band=firstLeadValue(
    p.linkedinCompanySizeBand,
    p.linkedin_company_size_band,
    p.employeeCountRange,
    p.employee_count_range,
    p.companySizeBand
  ) || (rangeMatch?rangeMatch[0]:'');
  const exact=rangeMatch?0:donorValue(rawEmployeeValue);
  const basis=firstLeadValue(
    p.employeeCountNote,
    p.employee_count_note,
    p.employeeEstimateBasis,
    p.donorEstimateBasis,
    p.linkedinMatchNotes,
    p.linkedin_match_notes,
    Array.isArray(p.evidenceSignals)?p.evidenceSignals.join('; '):p.evidenceSignals,
    p.googleRaw
  );
  if(exact){
    return {
      count:String(exact),
      confidence:firstLeadValue(p.employeeCountConfidence,p.employee_count_confidence) || (p.linkedinEmployeeCount||p.linkedin_employee_count?'high':'medium'),
      note:basis || 'Employee count estimate came from public scrape/enrichment signals.',
      numeric:exact
    };
  }
  if(band){
    return {
      count:band,
      confidence:firstLeadValue(p.employeeCountConfidence,p.employee_count_confidence) || 'medium',
      note:basis || 'Exact employee count was not found, so the available public company-size band is stored.',
      numeric:0
    };
  }
  const signalText=String([p.organizationType,p.industry,p.operationalIndicators,p.hiringActivity,p.careersPage,leadArrayText(p.evidenceSignals)].filter(Boolean).join(' ')).toLowerCase();
  let inferred='';
  if(/\bfleet|warehouse|multiple locations|dispatch|crews?|technicians?|commercial|manufacturing|staffing|logistics|trucking\b/.test(signalText)) inferred='10-49';
  if(/\bmultiple locations|branch|branches|regional|large fleet|distribution|factory|plant\b/.test(signalText)) inferred='25-99';
  if(inferred){
    return {
      count:inferred,
      confidence:'low',
      note:'Exact employee count was not public. Range is inferred from public operating signals such as crews, locations, fleet, hiring, or commercial operations.',
      numeric:0
    };
  }
  return {
    count:'',
    confidence:'unknown',
    note:'No reasonable employee count estimate was found from website, listing, LinkedIn, hiring, or public source signals.',
    numeric:0
  };
}

function goallLeadSignals(p={},employee={}){
  const evidence=leadArrayText(p.evidenceSignals);
  const growth=firstLeadValue(
    p.growthSignals,
    p.growth_signals,
    p.growthActivity,
    p.operationalActivity,
    p.eventsOrCampaigns,
    p.newsRaw,
    p.news_raw_last_60_days
  );
  const leadership=firstLeadValue(
    p.leadershipSignals,
    p.leadership_signals,
    p.leadershipChangeSummary,
    p.leadership_change_summary,
    p.decisionMakerName?`${p.decisionMakerName}${p.decisionMakerTitle?' - '+p.decisionMakerTitle:''}`:'',
    p.linkedinCurrentTitle
  );
  const workforce=firstLeadValue(
    p.workforcePainSignals,
    p.workforce_pain_signals,
    p.workforceStabilitySignal,
    p.workforce_stability_signal,
    p.hiringActivity,
    p.careersPage,
    p.reviewSentimentTrend,
    p.operationalIndicators
  );
  const engagement=firstLeadValue(
    p.engagementActivitySignals,
    p.engagement_activity_signals,
    p.socialActivity,
    p.linkedinNotes,
    p.linkedin_notes,
    p.linkedinCompanyDescription,
    p.googleReviewCount||p.google_rating?`${p.googleReviewCount||''} Google reviews${p.googleRating?' / '+p.googleRating+' rating':''}`:'',
    p.website?'Active website found':''
  );
  const missing=[
    employee.count?'':'employee count estimate',
    p.decisionMakerName?'':'decision-maker name',
    validEmail(p.email)?'':'decision-maker or company email',
    validPhone(p.phone)?'':'phone',
    p.linkedinCompanyUrl||p.linkedinOrganizationUrl?'':'company LinkedIn page',
    growth?'':'recent growth signal'
  ].filter(Boolean);
  return {
    growth:growth || 'No specific growth event found yet.',
    leadership:leadership || 'No named leadership signal found yet.',
    workforce:workforce || 'No clear hiring, retention, or workforce pain signal found yet.',
    engagement:engagement || 'Limited public engagement/activity signal found.',
    evidence:evidence || '',
    missing
  };
}

function buildGoallFirstCallAngle(p={},employee={},signals={}){
  const name=p.organizationName||p.name||'the company';
  const growth=signals.growth && !/^No specific/i.test(signals.growth) ? signals.growth : '';
  const workforce=signals.workforce && !/^No clear/i.test(signals.workforce) ? signals.workforce : '';
  const employeePhrase=employee.count ? `${employee.count} employees` : 'an employee base';
  if(p.recommendedFirstCallAngle||p.recommended_first_call_angle) return p.recommendedFirstCallAngle||p.recommended_first_call_angle;
  if(growth || workforce){
    const hook=growth || workforce;
    return `I noticed ${name} appears to have ${employeePhrase} and ${hook}. We work with growing employers that are trying to retain good people while controlling benefits and workforce costs.`;
  }
  return `I was looking at ${name} and saw enough employee-base and operating activity to think retention, hiring, benefits costs, or workforce stability may be relevant. We help employers make that easier to manage.`;
}

function buildGoallIntelligenceProfile(p={},exactIndustry='business'){
  const employee=goallEmployeeEstimate(p);
  const signals=goallLeadSignals(p,employee);
  const contactability=leadContactability(p);
  const company=p.organizationName||p.name||'Unnamed company';
  const overview=`${company} is a ${exactIndustry||p.industry||p.organizationType||'business'}${p.location?' in '+p.location:''}.`;
  const firstCall=buildGoallFirstCallAngle(p,employee,signals);
  const missing=signals.missing.length?signals.missing.join(', '):'No major caller-critical gaps.';
  const relevance=[
    employee.count?`employee base estimated at ${employee.count}`:'employee count not yet verified',
    signals.growth && !/^No specific/i.test(signals.growth)?'growth/activity signal found':'growth signal weak',
    signals.workforce && !/^No clear/i.test(signals.workforce)?'workforce or hiring signal found':'workforce pain unclear',
    contactability.contactabilityStatus.replace(/_/g,' ')
  ].join('; ');
  const note=[
    `Company overview: ${overview}`,
    `Employee count estimate: ${employee.count||'unknown'} (${employee.confidence}). ${employee.note}`,
    `Growth signals discovered: ${signals.growth}`,
    `Leadership signals discovered: ${signals.leadership}`,
    `Workforce or hiring signals discovered: ${signals.workforce}`,
    `Engagement/activity signals: ${signals.engagement}`,
    `Why GOALL may be relevant: ${relevance}.`,
    `Recommended first-call approach: ${firstCall}`,
    `Missing data: ${missing}`
  ].join('\n');
  return {employee,signals,firstCall,missing,note,overview};
}

function strongGoallManualReviewLead(p={},intel=buildGoallIntelligenceProfile(p,p.aiExactIndustry||p.industry||p.organizationType||'business')){
  const hasGrowth=intel.signals.growth && !/^No specific/i.test(intel.signals.growth);
  const hasWorkforce=intel.signals.workforce && !/^No clear/i.test(intel.signals.workforce);
  const hasLeadership=intel.signals.leadership && !/^No named/i.test(intel.signals.leadership);
  const hasEmployees=!!intel.employee.count && intel.employee.confidence!=='unknown';
  const hasPublicFootprint=!!(p.website||p.googleMapsUrl||p.googleRaw||p.linkedinCompanyUrl||p.linkedinOrganizationUrl);
  return hasPublicFootprint && hasEmployees && (hasGrowth || hasWorkforce || hasLeadership);
}

function leadCompanySummary(p,exactIndustry,contactability){
  const name=p.organizationName||p.name||'Unnamed business';
  const location=p.location||[p.city,p.state].filter(Boolean).join(', ')||'unclear';
  const employees=p.scrapedNumberOfEmployees||p.employeeCount||p.approximateDonors||'unclear';
  return `${name} is a ${exactIndustry||'business'} in ${location}. Employee signal: ${employees}. Contactability: ${contactability.contactabilityStatus}. Primary sales angle: ${p.nextOutreachAngle||p.recommendedOutreachAngle||'GOALL can speak to growth, pipeline, employee-base complexity, and operational follow-through.'}`;
}

function leadCallScript(p){
  const name=p.decisionMakerName||'there';
  const company=p.organizationName||p.name||'your company';
  const angle=p.nextOutreachAngle||p.recommendedOutreachAngle||'growth and employee-base complexity';
  return `Hi ${name}, this is Mark with GOALL. I was looking at ${company} and noticed a few signs that your team may be dealing with ${angle}. I wanted to ask one quick question: are you currently looking for ways to improve lead flow, follow-up, or revenue consistency without adding more chaos to the team?`;
}

function leadCustomFieldsFromProspect(p){
  const name=p.organizationName||p.name||'';
  const donorCount=donorValue(p.approximateDonors||p.estimatedDonors||p.donorCount);
  const exactIndustry=String(p.aiExactIndustry||p.ai_exact_industry||p.exactIndustry||p.industry||p.cause||p.primaryService||'unclear').trim()||'unclear';
  const isGoall=(p.leadProfile||'').toLowerCase()!=='westwood';
  const automation=isGoall?mapGoallAutomationTag(p):{};
  const normalizedProspect={
    ...p,
    email:p.email||p.decisionMakerEmail||p.decision_maker_email||'',
    phone:p.phone||p.decisionMakerPhone||p.decision_maker_phone||'',
    linkedinPersonalUrl:p.linkedinPersonalUrl||p.decisionMakerLinkedin||p.decisionMakerLinkedIn||p.decision_maker_linkedin||'',
    linkedinCompanyUrl:p.linkedinCompanyUrl||p.companyLinkedin||p.companyLinkedIn||p.company_linkedin||''
  };
  p=normalizedProspect;
  const contactability=leadContactability(p);
  const goallIntel=isGoall?buildGoallIntelligenceProfile(p,exactIndustry):null;
  const manualReviewOnly=isGoall && !contactability.importable && strongGoallManualReviewLead(p,goallIntel);
  const now=new Date().toISOString();
  const processedAt=p.leadLastProcessedAt||p.lead_last_processed_at||now;
  const ingestedAt=p.leadIngestedAt||p.lead_ingested_at||processedAt;
  const enrichmentRunId=p.enrichmentRunId||p.enrichment_run_id||`goall-${crypto.createHash('sha1').update(`${name}|${p.website||''}|${processedAt}`).digest('hex').slice(0,12)}`;
  const dedupeKey=p.leadDedupeKey||p.lead_dedupe_key||goallLeadKey(p);
  const enrichmentStatus=p.leadEnrichmentStatus||p.lead_enrichment_status||(p.rocketReachStatus&&/error|failed|rate|not set|skipped/i.test(p.rocketReachStatus)?'partial':'enriched');
  const google=parseLeadJson(p.googleRaw||p.googleData);
  const rocket=p.rocketReach?.data||p.rocketReachData||{};
  const evidence=Array.isArray(p.evidenceSignals)?p.evidenceSignals.filter(Boolean):(p.evidenceSignals?[p.evidenceSignals]:[]);
  const positiveSignals=[
    p.website?'active website':'',
    validEmail(p.email)?'valid email':'',
    validPhone(p.phone)?'valid phone':'',
    p.decisionMakerName?'decision-maker found':'',
    donorCount?`${donorCount} employee signal`:'',
    p.hiringActivity||p.careersPage?'hiring/careers signal':'',
    p.growthActivity?'growth signal':'',
    reviewCountFromLead(p)?`${reviewCountFromLead(p)} Google reviews`:'',
    ...evidence.slice(0,6)
  ].filter(Boolean);
  const negativeSignals=[
    !validEmail(p.email)?'email missing':'',
    !p.decisionMakerName?'decision-maker not verified':'',
    p.weakFitConcerns||''
  ].filter(Boolean);
  const signalSummary=positiveSignals.length?positiveSignals.join('; '):'Limited public signals found.';
  const topIndicators=positiveSignals.slice(0,5).join('\n');
  const salesAngle=goallIntel?.firstCall||p.nextOutreachAngle||p.recommendedOutreachAngle||'Position GOALL around growth, follow-up, employee-base complexity, and turning missed opportunities into pipeline.';
  const contactPayload=[
    `Decision maker: ${p.decisionMakerName||'not verified'}`,
    `Title: ${p.decisionMakerTitle||p.linkedinCurrentTitle||'unclear'}`,
    `Email: ${contactability.email||'missing'}`,
    `Phone: ${contactability.phone||'missing'}`,
    `LinkedIn: ${p.linkedinPersonalUrl||p.linkedin_profile_url||''}`,
    `Match confidence: ${p.linkedinMatchConfidence||p.linkedin_match_confidence||'unclear'}`
  ].join('\n');
  const rawCompanyContext=JSON.stringify({
    company:name,
    website:p.website||'',
    google,
    evidenceSignals:evidence,
    source:p.source||'LimitLess Leads',
    searchMarket:p.searchMarket||p.location||'',
    raw:p.raw||null
  }).slice(0,9000);
  const rawLinkedInPersonal=JSON.stringify(rocket.rawPreview?rocket:p.rocketReach||{}).slice(0,9000);
  const enrichment=[
    `Decision maker: ${p.decisionMakerName||'unclear'}`,
    `Title: ${p.decisionMakerTitle||'unclear'}`,
    `Contactability: ${contactability.contactabilityStatus}`,
    `Has email: ${contactability.hasEmail}`,
    `Has phone: ${contactability.hasPhone}`,
    `Email eligibility: ${contactability.emailEligibility}`,
    `Phone eligibility: ${contactability.phoneEligibility}`,
    `Initial email sent: ${contactability.initialEmailSent}`,
    `Lead score: ${p.leadScore||p.lead_score||'unclear'}`,
    `Lead score reason: ${p.leadScoreReason||p.lead_score_reason||'unclear'}`,
    automation.automationTag?`Automation tag: ${automation.automationTag}`:'',
    automation.automationTagReason?`Automation tag reason: ${automation.automationTagReason}`:'',
    automation.tagConfidence?`Tag confidence: ${automation.tagConfidence}`:'',
    automation.automationTag?`Needs new automation: ${automation.needsNewAutomation}`:'',
    automation.suggestedNewAutomationTag?`Suggested new automation: ${automation.suggestedNewAutomationTag}`:'',
    `GOALL fit score: ${p.goallFitScore||'unclear'}`,
    `GOALL fit reason: ${p.goallFitReason||'unclear'}`,
    `Email source: ${p.emailSource||'unclear'} (${p.emailQuality||classifyEmail(p.email)})`,
    `RocketReach: ${p.rocketReachStatus||p.rocketReach?.error||p.rocketReach?.data?.rawPreview||'not available'}`,
    `Employee estimate: ${goallIntel?.employee?.count||p.estimatedEmployeeCount||p.estimated_employee_count||'unclear'}`,
    `Employee estimate confidence: ${goallIntel?.employee?.confidence||p.employeeCountConfidence||p.employee_count_confidence||'unclear'}`,
    `Employee estimate basis: ${goallIntel?.employee?.note||p.donorEstimateBasis||p.employeeEstimateBasis||'unclear'}`,
    `Growth signals: ${goallIntel?.signals?.growth||p.growthSignals||p.growth_signals||p.growthActivity||'unclear'}`,
    `Workforce pain signals: ${goallIntel?.signals?.workforce||p.workforcePainSignals||p.workforce_pain_signals||p.workforceStabilitySignal||'unclear'}`,
    `Recommended first call angle: ${goallIntel?.firstCall||p.nextOutreachAngle||'unclear'}`,
    `Confidence: ${p.confidence||'unclear'}`
  ].filter(Boolean).join('\n');
  const fields = {
    lead_source_system:'Grace Intelligence',
    lead_ingested_at:ingestedAt,
    lead_ingestion_id:enrichmentRunId,
    lead_processing_status:contactability.importable?'ready_for_import':(manualReviewOnly?'manual_review':'rejected'),
    painpoint:p.painpoint||p.painPoint||salesAngle,
    call_transcript:p.callTranscript||p.call_transcript||'',
    lead_dedupe_key:dedupeKey,
    lead_monitoring_enabled:String(p.leadMonitoringEnabled??true),
    company_payload:[
      `Company: ${name}`,
      `Type: ${p.organizationType||p.industry||'business'}`,
      `Exact industry: ${exactIndustry}`,
      automation.automationTag?`Automation tag: ${automation.automationTag}`:'',
      `Fit: ${p.partnerFit||p.likelihood||'unclear'}`,
      `Employees: ${donorCount||'unclear'}`,
      `Location: ${p.location||'unclear'}`,
      `Website: ${p.website?'active':'unclear'}`
    ].filter(Boolean).join(' | '),
    google_raw:p.googleRaw||p.googleData||'No Google data found',
    company_signals:[
      `Hiring activity: ${p.hiringActivity||p.careersPage||p.donationPage||'unclear'}`,
      `Employee size indicators: ${Array.isArray(p.evidenceSignals)?p.evidenceSignals.join('; '):(p.evidenceSignals||p.donorEstimateBasis||'unclear')}`,
      `Growth activity: ${p.growthActivity||p.fundraisingActivity||'unclear'}`,
      `Operational activity: ${p.operationalActivity||p.eventsOrCampaigns||'unclear'}`,
      `Decision-maker signals: ${p.decisionMakerTitle||p.developmentStaff||'unclear'}`,
      `Public activity: ${p.socialActivity||'unclear'}`,
      `Operational indicators: ${p.operationalIndicators||'unclear'}`,
      automation.automationTag?`Automation tag: ${automation.automationTag}`:'',
      automation.automationTagReason?`Automation reason: ${automation.automationTagReason}`:'',
      `Weak-fit concerns: ${p.weakFitConcerns||'unclear'}`
    ].filter(Boolean).join('\n'),
    enrichment_data:enrichment,
    ai_exact_industry:exactIndustry,
    business_category_secondary:p.businessCategorySecondary||p.business_category_secondary||p.category||p.subcategory||'',
    google_place_id:p.googlePlaceId||p.google_place_id||google.place_id||google.placeId||'',
    google_maps_url:p.googleMapsUrl||p.google_maps_url||google.google_maps_url||google.maps_url||google.location_link||google.url||'',
    google_review_count:String(p.googleReviewCount||p.google_review_count||google.reviews||google.review_count||reviewCountFromLead(p)||''),
    google_rating:String(p.googleRating||p.google_rating||google.rating||''),
    google_reviews_snippet:p.googleReviewsSnippet||p.google_reviews_snippet||safeLeadString(google.reviews_data||google.reviews_snippet||'').slice(0,3000),
    lead_score:String(p.leadScore||p.lead_score||''),
    lead_score_reason:p.leadScoreReason||p.lead_score_reason||'',
    lead_scored_at:p.leadScoredAt||p.lead_scored_at||processedAt,
    lead_rejected_reason:contactability.importable||manualReviewOnly?'':(contactability.rejectionReason||'missing_email_and_phone'),
    lead_scoring_version:p.leadScoringVersion||p.lead_scoring_version||'goall-v2-contactability-company-person',
    approximat_donor_count:donorCount?String(donorCount):'unclear',
    linkedin_personal:p.linkedinPersonalUrl||p.decisionMakerLinkedIn||'',
    linkedin_company:p.linkedinCompanyUrl||p.linkedinOrganizationUrl||'',
    linkedin_company_id:p.linkedinCompanyId||p.linkedin_company_id||rocket.companyId||'',
    linkedin_employee_count:String(p.linkedinEmployeeCount||p.linkedin_employee_count||rocket.employeeCount||p.linkedinCompanyEmployeeCount||''),
    linkedin_company_size_band:p.linkedinCompanySizeBand||p.linkedin_company_size_band||rocket.companySizeBand||'',
    linkedin_company_description:p.linkedinCompanyDescription||p.linkedin_company_description||rocket.companyDescription||'',
    linkedin_company_location:p.linkedinCompanyLocation||p.linkedin_company_location||rocket.companyLocation||'',
    linkedin_company_founded_year:String(p.linkedinCompanyFoundedYear||p.linkedin_company_founded_year||rocket.companyFoundedYear||''),
    linkedin_match_confidence:p.linkedinMatchConfidence||p.linkedin_match_confidence||(p.decisionMakerName?'medium':'low'),
    linkedin_match_notes:p.linkedinMatchNotes||p.linkedin_match_notes||p.rocketReachStatus||'',
    linkedin_current_title:p.linkedinCurrentTitle||p.linkedin_current_title||p.decisionMakerTitle||rocket.title||'',
    linkedin_profile_location:p.linkedinProfileLocation||p.linkedin_profile_location||rocket.location||'',
    signals_summary:p.signalsSummary||p.signals_summary||signalSummary,
    signals_positive_count:String(p.signalsPositiveCount||p.signals_positive_count||positiveSignals.length),
    signals_top_indicators:p.signalsTopIndicators||p.signals_top_indicators||topIndicators,
    signals_confidence:p.signalsConfidence||p.signals_confidence||p.confidence||'moderate',
    signals_last_checked_at:p.signalsLastCheckedAt||p.signals_last_checked_at||processedAt,
    indicator_type:p.indicatorType||p.indicator_type||(p.hiringActivity||p.careersPage?'hiring':(reviewCountFromLead(p)?'public reputation':'business activity')),
    indicator_direction:p.indicatorDirection||p.indicator_direction||'positive',
    indicator_confidence:p.indicatorConfidence||p.indicator_confidence||p.confidence||'moderate',
    indicator_summary:p.indicatorSummary||p.indicator_summary||signalSummary,
    indicator_source_type:p.indicatorSourceType||p.indicator_source_type||'public web / Google / RocketReach',
    indicator_detected_at:p.indicatorDetectedAt||p.indicator_detected_at||processedAt,
    indicator_sales_angle:p.indicatorSalesAngle||p.indicator_sales_angle||salesAngle,
    indicator_requires_attention:String(p.indicatorRequiresAttention??true),
    workforce_stability_signal:p.workforceStabilitySignal||p.workforce_stability_signal||(p.hiringActivity||p.careersPage||'unclear'),
    layoff_signal_detected:String(!!(p.layoffSignalDetected||p.layoff_signal_detected)),
    layoff_signal_confidence:p.layoffSignalConfidence||p.layoff_signal_confidence||'unclear',
    layoff_signal_summary:p.layoffSignalSummary||p.layoff_signal_summary||'No layoff signal detected from current scrape.',
    leadership_change_detected:String(!!(p.leadershipChangeDetected||p.leadership_change_detected)),
    leadership_change_summary:p.leadershipChangeSummary||p.leadership_change_summary||(p.decisionMakerName?`Decision-maker found: ${p.decisionMakerName}${p.decisionMakerTitle?' - '+p.decisionMakerTitle:''}`:'No leadership change signal detected.'),
    hiring_freeze_signal:String(!!(p.hiringFreezeSignal||p.hiring_freeze_signal)),
    review_sentiment_trend:p.reviewSentimentTrend||p.review_sentiment_trend||(reviewCountFromLead(p)?'active public review footprint':'unclear'),
    monitoring_cadence:p.monitoringCadence||p.monitoring_cadence||'monthly',
    last_indicator_check_at:p.lastIndicatorCheckAt||p.last_indicator_check_at||processedAt,
    indicator_change_detected:String(!!(p.indicatorChangeDetected||p.indicator_change_detected)),
    last_indicator_notification_sent_at:p.lastIndicatorNotificationSentAt||p.last_indicator_notification_sent_at||'',
    indicator_notification_suppressed_until:p.indicatorNotificationSuppressedUntil||p.indicator_notification_suppressed_until||'',
    account_intelligence_summary:p.accountIntelligenceSummary||p.account_intelligence_summary||leadCompanySummary(p,exactIndustry,contactability),
    latest_indicator_update:p.latestIndicatorUpdate||p.latest_indicator_update||signalSummary,
    signals_negative_count:String(p.signalsNegativeCount||p.signals_negative_count||negativeSignals.length),
    enrichment_run_id:enrichmentRunId,
    enrichment_error:p.enrichmentError||p.enrichment_error||(/error|failed/i.test(p.rocketReachStatus||'')?p.rocketReachStatus:''),
    hours_of_operation:p.hoursOfOperation||p.hours||'',
    time_zone:p.timeZone||p.timezone||'',
    scraped_annual_revenue:p.scrapedAnnualRevenue||p.scraped_annual_revenue||p.annualRevenue||p.revenue||'',
    scraped_number_of_employees:p.scrapedNumberOfEmployees||p.scraped_number_of_employees||p.employeeCount||p.employees||donorCount||'',
    industry:exactIndustry,
    title:p.decisionMakerTitle||p.title||p.position||'',
    contact_payload:contactPayload,
    raw_company_signals:p.rawCompanySignals||p.raw_company_signals||signalSummary,
    enrichment_status:enrichmentStatus,
    call_script_angle:p.callScriptAngle||p.call_script_angle||salesAngle,
    recommended_outreach_angle:p.recommendedOutreachAngle||p.recommended_outreach_angle||salesAngle,
    news_count_last_60_days:String(p.newsCountLast60Days||p.news_count_last_60_days||0),
    ai_company_summary:p.aiCompanySummary||p.ai_company_summary||leadCompanySummary(p,exactIndustry,contactability),
    account_priority_level:p.accountPriorityLevel||p.account_priority_level||(
      Number(p.leadScore||4)===1?'highest priority':Number(p.leadScore||4)===2?'strong priority':Number(p.leadScore||4)===3?'watchlist':'low priority'
    ),
    call_script:p.callScript||p.call_script||leadCallScript(p),
    linkedin_notes:p.linkedinNotes||p.linkedin_notes||p.rocketReachStatus||'',
    raw_company_context_json:p.rawCompanyContextJson||p.raw_company_context_json||rawCompanyContext,
    raw_company_context_result_count:String(p.rawCompanyContextResultCount||p.raw_company_context_result_count||1),
    raw_news_result_count:String(p.rawNewsResultCount||p.raw_news_result_count||0),
    raw_linkedin_company_data:p.rawLinkedinCompanyData||p.raw_linkedin_company_data||JSON.stringify({url:p.linkedinCompanyUrl||'',rocketReachCompany:rocket}).slice(0,9000),
    raw_linkedin_personal_data:p.rawLinkedinPersonalData||p.raw_linkedin_personal_data||rawLinkedInPersonal,
    raw_web_result_count:String(p.rawWebResultCount||p.raw_web_result_count||evidence.length||1),
    raw_company_context_notes:p.rawCompanyContextNotes||p.raw_company_context_notes||`Source domain: ${leadDomain(p.website)||'unclear'}\n${signalSummary}`,
    raw_enrichment_notes:p.rawEnrichmentNotes||p.raw_enrichment_notes||enrichment,
    linkedin_url:p.linkedinPersonalUrl||p.linkedinCompanyUrl||'',
    lead_enrichment_status:enrichmentStatus,
    lead_last_processed_at:processedAt,
    raw_web_signals_json:p.rawWebSignalsJson||p.raw_web_signals_json||'',
    news_raw_last_60_days:p.newsRawLast60Days||p.news_raw_last_60_days||p.newsRaw||'',
    automation_tag:automation.automationTag||'',
    automation_tag_reason:automation.automationTagReason||'',
    normalized_industry:automation.normalizedIndustry||exactIndustry,
    raw_industry:automation.rawIndustry||exactIndustry,
    tag_confidence:automation.tagConfidence||'',
    needs_new_automation:automation.automationTag?String(!!automation.needsNewAutomation):'',
    suggested_new_automation_tag:automation.suggestedNewAutomationTag||''
  };
  if(isGoall && goallIntel){
    Object.assign(fields,{
      estimated_employee_count:goallIntel.employee.count||'',
      employee_count_confidence:goallIntel.employee.confidence||'unknown',
      employee_count_note:goallIntel.employee.note||'',
      growth_signals:goallIntel.signals.growth,
      leadership_signals:goallIntel.signals.leadership,
      workforce_pain_signals:goallIntel.signals.workforce,
      engagement_activity_signals:goallIntel.signals.engagement,
      decision_maker_name:p.decisionMakerName||'',
      decision_maker_title:p.decisionMakerTitle||p.linkedinCurrentTitle||'',
      decision_maker_email:contactability.email||'',
      decision_maker_phone:contactability.phone||'',
      decision_maker_linkedin:p.linkedinPersonalUrl||p.decisionMakerLinkedIn||'',
      company_linkedin:p.linkedinCompanyUrl||p.linkedinOrganizationUrl||'',
      goall_intelligence_note:goallIntel.note,
      recommended_first_call_angle:goallIntel.firstCall,
      missing_data:goallIntel.missing
    });
  }
  return fields;
}

async function getOpportunityTarget(){
  const data=await ghl('GET',`/opportunities/pipelines?locationId=${GHL_LOC}`);
  const pipelines=data.pipelines||data.data||[];
  if(GHL_OPPORTUNITY_PIPELINE_ID&&GHL_OPPORTUNITY_STAGE_ID){
    const pipeline=pipelines.find(p=>String(p.id||p._id||'')===String(GHL_OPPORTUNITY_PIPELINE_ID));
    if(!pipeline){
      const available=pipelines.map(p=>`${p.name||p.title||'Unnamed'} (${p.id||p._id||'no id'})`).slice(0,12).join(' | ');
      throw new Error(`Configured GHL_OPPORTUNITY_PIPELINE_ID ${GHL_OPPORTUNITY_PIPELINE_ID} was not found. Available pipelines: ${available||'none returned'}`);
    }
    const stages=pipeline.stages||pipeline.pipelineStages||[];
    const stage=stages.find(s=>String(s.id||s._id||'')===String(GHL_OPPORTUNITY_STAGE_ID));
    if(!stage){
      const available=stages.map(s=>`${s.name||s.title||'Unnamed'} (${s.id||s._id||'no id'})`).slice(0,20).join(' | ');
      throw new Error(`Configured GHL_OPPORTUNITY_STAGE_ID ${GHL_OPPORTUNITY_STAGE_ID} was not found in pipeline "${pipeline.name||pipeline.title||pipeline.id}". Available stages: ${available||'none returned'}`);
    }
    return {pipelineId:pipeline.id||pipeline._id,stageId:stage.id||stage._id,pipelineName:pipeline.name||pipeline.title||'',stageName:stage.name||stage.title||''};
  }
  const wantPipeline=String(GHL_OPPORTUNITY_PIPELINE_NAME||'').toLowerCase();
  const wantStage=String(GHL_OPPORTUNITY_STAGE_NAME||'').toLowerCase();
  const pipeline=pipelines.find(p=>{
    const name=String(p.name||p.title||'').toLowerCase();
    return wantPipeline && (name===wantPipeline || name.includes(wantPipeline));
  }) || {};
  if(!pipeline.id){
    const available=pipelines.map(p=>`${p.name||p.title||'Unnamed'} (${p.id||p._id||'no id'})`).slice(0,12).join(' | ');
    throw new Error(`No GHL opportunity pipeline matched "${GHL_OPPORTUNITY_PIPELINE_NAME}". Set GHL_OPPORTUNITY_PIPELINE_ID to the exact pipeline id in Railway. Available pipelines: ${available||'none returned'}`);
  }
  const stages=pipeline.stages||pipeline.pipelineStages||[];
  const stage=stages.find(s=>{
    const name=String(s.name||s.title||'').toLowerCase();
    return wantStage && name===wantStage;
  }) || stages.find(s=>{
    const name=String(s.name||s.title||'').toLowerCase();
    return wantStage && name.includes(wantStage);
  }) || {};
  if(!stage.id){
    const available=stages.map(s=>`${s.name||s.title||'Unnamed'} (${s.id||s._id||'no id'})`).slice(0,20).join(' | ');
    throw new Error(`No GHL opportunity stage matched "${GHL_OPPORTUNITY_STAGE_NAME}" in pipeline "${pipeline.name||pipeline.title||pipeline.id}". Set GHL_OPPORTUNITY_STAGE_ID to the exact stage id in Railway. Available stages: ${available||'none returned'}`);
  }
  return {pipelineId:pipeline.id,stageId:stage.id,pipelineName:pipeline.name||pipeline.title||'',stageName:stage.name||stage.title||''};
}

async function getPartnerOpportunityTarget(){
  const data=await ghl('GET',`/opportunities/pipelines?locationId=${GHL_LOC}`);
  const pipelines=data.pipelines||data.data||[];
  const pipeline=pipelines.find(p=>GHL_PARTNER_PIPELINE_ID
    ? String(p.id||p._id||'')===String(GHL_PARTNER_PIPELINE_ID)
    : String(p.name||p.title||'').trim().toLowerCase()===GHL_PARTNER_PIPELINE_NAME.toLowerCase());
  if(!pipeline) throw new Error(`No GHL pipeline matched "${GHL_PARTNER_PIPELINE_NAME}". Create it or set GHL_PARTNER_PIPELINE_ID.`);
  const stages=pipeline.stages||pipeline.pipelineStages||[];
  const stage=stages.find(s=>GHL_PARTNER_STAGE_ID
    ? String(s.id||s._id||'')===String(GHL_PARTNER_STAGE_ID)
    : String(s.name||s.title||'').trim().toLowerCase()===GHL_PARTNER_STAGE_NAME.toLowerCase());
  if(!stage) throw new Error(`No GHL stage matched "${GHL_PARTNER_STAGE_NAME}" in "${pipeline.name||pipeline.title}". Create it or set GHL_PARTNER_STAGE_ID.`);
  return {pipelineId:pipeline.id||pipeline._id,stageId:stage.id||stage._id,pipelineName:pipeline.name||pipeline.title||'',stageName:stage.name||stage.title||''};
}

const GOALL_PARTNER_TYPES=[
  'Employee Benefits Broker','Property & Casualty Agency','Life & Health Insurance Agency','General Insurance Brokerage',
  'Voluntary Benefits Provider','Section 125 Provider','SIMRP Provider','Payroll Company','Staffing Agency','HR Consultant',
  'Professional Association','Trade Organization','Industry Membership Organization','Conference Organizer','Referral Partner'
];
const GOALL_PRIORITY_ASSOCIATIONS=['SHRM','MGMA','AHA','AAHC','AGC','ABC','NAHB','ATA','NPTC','APA','ASA','NAPS','NARPM'];

function partnerTypeFromLead(p={}){
  const text=[p.partnerType,p.organizationType,p.industry,p.category,p.subcategory,p.organizationName,p.name].filter(Boolean).join(' ').toLowerCase();
  if(/association|membership|society|chamber/.test(text)) return 'Professional Association';
  if(/conference|expo|event organizer/.test(text)) return 'Conference Organizer';
  if(/payroll|paychex|adp/.test(text)) return 'Payroll Company';
  if(/staffing|recruit/.test(text)) return 'Staffing Agency';
  if(/section\s*125|cafeteria plan/.test(text)) return 'Section 125 Provider';
  if(/simrp/.test(text)) return 'SIMRP Provider';
  if(/voluntary benefits/.test(text)) return 'Voluntary Benefits Provider';
  if(/property.{0,3}casualty|commercial insurance|\bp&c\b/.test(text)) return 'Property & Casualty Agency';
  if(/life|health insurance|medicare/.test(text)) return 'Life & Health Insurance Agency';
  if(/benefits|employee benefit/.test(text)) return 'Employee Benefits Broker';
  if(/insurance|brokerage|agency/.test(text)) return 'General Insurance Brokerage';
  if(/hr consultant|human resources consult/.test(text)) return 'HR Consultant';
  if(/trade organization/.test(text)) return 'Trade Organization';
  return p.partnerType||'Referral Partner';
}

function partnerSourceUrls(p={}){
  return [...new Set([
    ...(Array.isArray(p.sourceUrls)?p.sourceUrls:String(p.sourceUrls||'').split(/[\n,]/)),
    p.website,p.googleMapsUrl,p.google_maps_url,p.linkedinCompanyUrl,p.linkedinPersonalUrl,p.membershipUrl,p.eventsUrl,p.sponsorUrl,p.vendorUrl
  ].map(v=>String(v||'').trim()).filter(v=>/^https?:\/\//i.test(v)))];
}

function partnerPotentialReach(p={},type=partnerTypeFromLead(p)){
  const direct=donorValue(p.potentialReach||p.membershipSize||p.memberCount||p.attendeeCount||p.employerClients||p.businessClients);
  if(direct) return direct;
  const employees=donorValue(p.employeeCount||p.estimatedEmployeeCount||p.scrapedNumberOfEmployees||p.linkedinEmployeeCount||p.approximateDonors);
  const reviews=donorValue(p.googleReviewCount||p.reviews);
  if(/Association|Organization/.test(type)) return Math.max(employees?employees*100:0,reviews?reviews*20:0,500);
  if(type==='Conference Organizer') return Math.max(employees?employees*75:0,reviews?reviews*15:0,250);
  if(/Broker|Agency|Insurance|Benefits/.test(type)) return Math.max(employees?employees*18:0,reviews?reviews*6:0,50);
  if(type==='Payroll Company'||type==='Staffing Agency') return Math.max(employees?employees*12:0,reviews?reviews*5:0,50);
  return Math.max(employees?employees*8:0,reviews?reviews*4:0,25);
}

function scorePartnerFit(p={}){
  const partnerType=partnerTypeFromLead(p);
  const potentialReach=partnerPotentialReach(p,partnerType);
  const sources=partnerSourceUrls(p);
  const text=JSON.stringify(p).toLowerCase();
  const audienceSize=Math.min(30,potentialReach>=10000?30:potentialReach>=2500?26:potentialReach>=500?21:potentialReach>=100?15:9);
  const employerAccess=Math.min(25,/benefit|insurance|payroll|staffing|association|membership|trade organization/.test(partnerType.toLowerCase())?25:16);
  const priority=GOALL_PRIORITY_ASSOCIATIONS.some(name=>new RegExp(`\\b${name.toLowerCase()}\\b`,'i').test(`${p.organizationName||p.name||''} ${p.website||''}`));
  const trustCredibility=Math.min(20,(priority?20:0)||((p.googleRating||p.executiveLeadership||p.decisionMakerName||sources.length>=2)?16:10));
  const easeOfPartnership=Math.min(15,(validEmail(p.email)||validPhone(p.phone)?8:3)+(/sponsor|vendor|partner|conference|events? director|membership director/.test(text)?7:3));
  const growthPotential=Math.min(10,(/national|multi.?state|growth|expansion|annual conference/.test(text)?10:potentialReach>=500?8:5));
  const partnershipFitScore=Math.min(100,audienceSize+employerAccess+trustCredibility+easeOfPartnership+growthPotential);
  const reasonForScore=`Audience ${audienceSize}/30; employer access ${employerAccess}/25; trust/credibility ${trustCredibility}/20; ease of partnership ${easeOfPartnership}/15; growth potential ${growthPotential}/10. Estimated reach: ${potentialReach.toLocaleString()}.`;
  const recommendedOutreachAngle=/Association|Organization|Conference/.test(partnerType)
    ? 'Propose a member-value education, conference sponsorship, or preferred-vendor relationship that introduces GOALL to many employers at once.'
    : 'Propose a referral or co-selling partnership that adds GOALL to the organization’s employer relationships without disrupting its core service.';
  return {...p,leadProfile:'partners',partnerType,potentialReach,partnershipFitScore,reasonForScore,recommendedOutreachAngle,sources,sourceUrls:sources,researchSourceCount:sources.length,researchQuality:sources.length>=2?'supported':'needs second source'};
}

function partnerPreviewText(discovered={}){
  const leads=(discovered.leads||[]).map(scorePartnerFit).sort((a,b)=>b.partnershipFitScore-a.partnershipFitScore||b.potentialReach-a.potentialReach);
  return [
    `Found ${leads.length} strategic partner prospect${leads.length===1?'':'s'}.`,
    'Partner question: Could this organization help GOALL reach many employers?',
    `Search: ${discovered.organizationType||'strategic partners'} | ${discovered.market||'United States'}`,
    'Research standard: public information only; two supporting sources preferred; recent sources prioritized.',
    '',
    ...leads.map((p,i)=>`${i+1}. ${p.organizationName||p.name||'Unnamed organization'}\n   Partner type: ${p.partnerType}\n   Potential reach: ${p.potentialReach.toLocaleString()}\n   Partnership fit: ${p.partnershipFitScore}/100\n   Reason: ${p.reasonForScore}\n   Outreach: ${p.recommendedOutreachAngle}\n   Contact: ${p.decisionMakerName||'not identified'}${p.decisionMakerTitle?' - '+p.decisionMakerTitle:''} | ${p.email||'email unavailable'} | ${p.phone||'phone unavailable'}\n   Sources (${p.sourceUrls.length}): ${p.sourceUrls.join(', ')||'second-source research needed'}`),
    '',
    'Review and approve before pushing to GOALL Strategic Partners / New Limitless Lead Added.'
  ].join('\n');
}

function partnerCustomFields(p={}){
  const scored=scorePartnerFit(p);
  return {
    partner_type:scored.partnerType,
    organization_size:String(p.organizationSize||p.employeeCount||p.estimatedEmployeeCount||p.linkedinEmployeeCount||''),
    potential_reach:String(scored.potentialReach),
    partnership_fit_score:String(scored.partnershipFitScore),
    reason_for_score:scored.reasonForScore,
    recommended_outreach_angle:scored.recommendedOutreachAngle,
    source_urls:scored.sourceUrls.join('\n'),
    lead_source_system:'GOALL Strategic Partner Prospecting',
    date_added:p.dateAdded||new Date().toISOString(),
    linkedin_url:p.linkedinPersonalUrl||p.linkedinCompanyUrl||p.linkedinUrl||'',
    title:p.decisionMakerTitle||p.contactTitle||''
  };
}

async function findPartnerOpportunity(contactId,target){
  const data=await fetchGhlOpportunities({status:'open',limit:100}).catch(()=>({opportunities:[]}));
  const opportunities=data.data?.opportunities||data.opportunities||[];
  return opportunities.find(o=>opportunityContactId(o)===String(contactId)&&String(o.pipelineId||o.pipeline_id||o.pipeline?.id||'')===String(target.pipelineId))||null;
}

async function upsertGhlPartnerLead(raw={}){
  const p=scorePartnerFit(sanitizeDecisionMaker(raw));
  const target=await getPartnerOpportunityTarget();
  const fields=partnerCustomFields(p);
  const ids=await resolveLeadFieldIds().catch(()=>GHL_LEAD_FIELD_IDS);
  const customFields=leadCustomFieldPayloads(ids,fields);
  const duplicate=await findExistingGhlLeadDuplicate(p);
  let contactId=duplicate?.id||'';
  let updated=!!duplicate;
  const contactPayload={
    locationId:GHL_LOC,companyName:p.organizationName||p.name||'Unnamed partner',website:p.website||undefined,
    email:validEmail(p.email)?p.email:undefined,phone:validPhone(p.phone)?p.phone:undefined,
    city:p.city||undefined,state:p.state||undefined,source:'GOALL Strategic Partner Prospecting',
    tags:['partner','GOALL Strategic Partner','Limitless Leads',p.partnerType],customFields:customFields.length?customFields:undefined
  };
  const decisionName=String(p.decisionMakerName||p.contactName||'').trim().split(/\s+/);
  if(decisionName[0]){contactPayload.firstName=decisionName[0];contactPayload.lastName=decisionName.slice(1).join(' ')||undefined;}
  if(contactId){
    const {locationId,...updatePayload}=contactPayload;
    await ghlStrict('PUT',`/contacts/${contactId}`,updatePayload);
  }else{
    const created=await ghlStrict('POST','/contacts',contactPayload);
    contactId=(created.contact||created).id;
  }
  if(!contactId) throw new Error(`GHL contact upsert returned no contact id for ${p.organizationName||p.name||'partner'}`);
  await ghlStrict('POST',`/contacts/${contactId}/tags`,{tags:contactPayload.tags}).catch(()=>{});
  const note=[`Partner type: ${p.partnerType}`,`Potential reach: ${p.potentialReach}`,`Partnership fit: ${p.partnershipFitScore}/100`,p.reasonForScore,`Recommended outreach: ${p.recommendedOutreachAngle}`,`Sources: ${p.sourceUrls.join(', ')||'Needs second source'}`,p.membershipSize?`Membership size: ${p.membershipSize}`:'',p.geographicReach?`Geographic reach: ${p.geographicReach}`:'',p.conferenceInformation?`Conference: ${p.conferenceInformation}`:'',p.vendorOpportunities?`Vendor opportunities: ${p.vendorOpportunities}`:'',p.sponsorOpportunities?`Sponsor opportunities: ${p.sponsorOpportunities}`:'',p.benefitsEvidence?`Benefits evidence: ${p.benefitsEvidence}`:'',p.lifeInsuranceEvidence?`Life evidence: ${p.lifeInsuranceEvidence}`:'',p.commercialInsuranceEvidence?`Commercial evidence: ${p.commercialInsuranceEvidence}`:''].filter(Boolean).join('\n');
  await ghlStrict('POST',`/contacts/${contactId}/notes`,{body:note}).catch(()=>{});
  let opportunity=await findPartnerOpportunity(contactId,target);
  if(!opportunity){
    const created=await createGhlOpportunity({locationId:GHL_LOC,pipelineId:target.pipelineId,pipelineStageId:target.stageId,name:p.organizationName||p.name,status:'open',contactId,monetaryValue:p.potentialReach,source:'GOALL Strategic Partner Prospecting'});
    opportunity=created.opportunity||created;
  }
  return {name:p.organizationName||p.name,contactId,updated,opportunity,pipelineName:target.pipelineName,stageName:target.stageName,partnershipFitScore:p.partnershipFitScore,potentialReach:p.potentialReach};
}

async function importApprovedPartnerLeads(body={}){
  const leads=(Array.isArray(body.leads)?body.leads:[]).map(scorePartnerFit);
  if(!leads.length) throw new Error('No approved partner leads were provided for import.');
  const created=[],failed=[];
  await mapWithConcurrency(leads,GOALL_LEAD_IMPORT_CONCURRENCY,async lead=>{
    try{created.push(await upsertGhlPartnerLead(lead));}catch(e){failed.push({name:lead.organizationName||lead.name,error:e.message});}
  });
  const updated=created.filter(x=>x.updated).length;
  const content=[`Pushed ${created.length} approved strategic partner${created.length===1?'':'s'} to GHL.`,updated?`Updated ${updated} existing contact${updated===1?'':'s'} instead of creating duplicates.`:'','Pipeline: GOALL Strategic Partners','Stage: New Limitless Lead Added',failed.length?`Failed: ${failed.length}`:''].filter(Boolean).join('\n');
  return {ok:true,created,failed,content};
}

function normalizeOutscraperPlace(row,organizationType,employeeMinimum,market){
  const name=row.name||row.title||row.business_name||row.organizationName||'';
  const city=[row.city,row.state].filter(Boolean).join(', ') || row.full_address || row.address || market || '';
  const employeeSignals=[
    row.description,
    row.category,
    row.subtypes,
    row.reviews ? `${row.reviews} Google reviews` : '',
    row.rating ? `${row.rating} rating` : '',
    row.website ? 'active website' : '',
    row.posts ? 'Google posts visible' : ''
  ].flat().filter(Boolean);
  return {
    organizationName:name,
    website:row.site||row.website||row.url||'',
    address1:row.street||row.address||row.full_address||'',
    city:row.city||'',
    state:row.state||row.us_state||'',
    country:row.country||'',
    postalCode:row.postal_code||row.zip||row.zipcode||'',
    googlePlaceId:row.place_id||row.placeId||row.google_id||'',
    googleMapsUrl:row.location_link||row.google_maps_url||row.maps_url||row.url||'',
    googleReviewCount:row.reviews||row.review_count||'',
    googleRating:row.rating||'',
    googleReviewsSnippet:row.reviews_data||row.reviews_snippet||row.description||'',
    cause:organizationType,
    location:city,
    organizationType,
    partnerFit:'unclear',
    approximateDonors:donorValue(row.approximateDonors||row.employee_count||row.employees||row.employees_count||row.staff_count)||0,
    donorEstimateBasis:employeeSignals.join('; ') || 'Outscraper public listing signals',
    employeeEstimateBasis:employeeSignals.join('; ') || 'Outscraper public listing signals',
    evidenceSignals:employeeSignals,
    decisionMakerName:'',
    decisionMakerTitle:'',
    email:firstEmailFrom(row.email,row.emails,row.email_1,row.email_2,row.email_3,row.contacts,row.owner,row.about,row.description,row),
    phone:row.phone||row.phone_number||row.phoneNumber||'',
    linkedinPersonalUrl:'',
    linkedinCompanyUrl:row.linkedin||row.linkedin_url||'',
    donationPage:'',
    fundraisingActivity:'',
    hiringActivity:'',
    careersPage:'',
    growthActivity:'',
    eventsOrCampaigns:'',
    socialActivity:row.facebook||row.instagram||row.twitter ? [row.facebook,row.instagram,row.twitter].filter(Boolean).join('; ') : '',
    operationalIndicators:row.category||row.type||'',
    weakFitConcerns:'',
    googleRaw:JSON.stringify(row).slice(0,2200),
    rawCompanyContextJson:JSON.stringify(row).slice(0,9000),
    rawCompanyContextResultCount:1,
    rawWebResultCount:1,
    newsRaw:'No recent news found',
    hoursOfOperation:row.working_hours||row.hours||'',
    timeZone:row.timezone||'',
    nextOutreachAngle:'Invite them to explore whether GOALL Agency can support their growth, outreach, or pipeline goals.',
    confidence:name?'moderate':'weak'
  };
}

async function discoverOutscraperProspects({organizationType,employeeMinimum,market,limit,leadProfile}){
  const outscraperKey=await resolveIntegrationSecret('outscraper','api_key',OUTSCRAPER_API_KEY);
  if(!outscraperKey) return {configured:false, leads:[], error:'OUTSCRAPER_API_KEY is not set'};
  const url=new URL(OUTSCRAPER_GOOGLE_MAPS_SEARCH_URL);
  const query=leadProfile==='westwood'
    ? `${organizationType} non-government, non-municipal private businesses in ${market} that have contact email addresses available`
    : `${organizationType} businesses in ${market}`;
  url.searchParams.set('query',query);
  url.searchParams.set('limit',String(limit||12));
  url.searchParams.set('async','false');
  const response=await fetchWithTimeout(url.toString(),{headers:{'X-API-KEY':outscraperKey}},OUTSCRAPER_FETCH_TIMEOUT_MS,'Level 1 map/business search');
  const data=await readJsonResponse(response);
  if(!response.ok) return {configured:true, leads:[], error:data.errorMessage||data.message||`Outscraper ${response.status}`};
  const rows=(Array.isArray(data.data)?data.data:[data]).flat(4).filter(v=>v&&typeof v==='object');
  const leads=rows.map(r=>normalizeOutscraperPlace(r,organizationType,employeeMinimum,market))
    .map(p=>({...p,leadProfile,source:leadProfile==='westwood'?'Grace Intelligence Limitless Leads':'LimitLess Leads'}))
    .filter(p=>p.organizationName)
    .slice(0,limit||12);
  return {configured:true, leads, rawCount:rows.length};
}

function buildGoallSearchJobs(plan){
  const jobs=[];
  const industries=plan.industries.length?plan.industries:['businesses'];
  if(plan.fastSearch){
    return industries.slice(0,3).map(industry=>({industry,market:plan.market}));
  }
  for(const industry of industries){
    jobs.push({industry,market:plan.market});
  }
  if(plan.cities.length){
    let cityIndex=0;
    while(jobs.length<GOALL_LEAD_SEARCH_CALLS_MAX && cityIndex<plan.cities.length){
      for(const industry of industries){
        if(jobs.length>=GOALL_LEAD_SEARCH_CALLS_MAX) break;
        jobs.push({industry,market:`${plan.cities[cityIndex]}, Arizona`});
      }
      cityIndex+=1;
    }
  }
  return jobs.slice(0,GOALL_LEAD_SEARCH_CALLS_MAX);
}

const GOALL_LEAD_JOB_CONCURRENCY = Number(process.env.GOALL_LEAD_JOB_CONCURRENCY) || 6;
const GOALL_CRM_DEDUPE_CONCURRENCY = Number(process.env.GOALL_CRM_DEDUPE_CONCURRENCY) || 8;

function normalizedPhoneDigits(value){
  return String(value||'').replace(/\D/g,'').replace(/^1(?=\d{10}$)/,'');
}

// Checks whether a scraped lead already exists in the GHL CRM by email or phone.
// Returns {exists, contactId, matchedOn} - never throws; treats lookup failures as "not found"
// so a transient GHL/API hiccup doesn't silently block the scraper from importing leads.
async function checkCrmDuplicate(lead){
  const email=String(lead.email||'').toLowerCase().trim();
  const phoneDigits=normalizedPhoneDigits(lead.phone||lead.decisionMakerPhone);
  if(!email && !phoneDigits) return {exists:false};
  try{
    if(email){
      const matches=await ghlMcp.searchContacts({query:email,limit:5}).catch(()=>[]);
      const hit=(matches||[]).find(c=>String(c.email||'').toLowerCase().trim()===email);
      if(hit) return {exists:true,contactId:hit.id,matchedOn:'email'};
    }
    if(phoneDigits){
      const matches=await ghlMcp.searchContacts({query:phoneDigits,limit:5}).catch(()=>[]);
      const hit=(matches||[]).find(c=>normalizedPhoneDigits(c.phone)===phoneDigits);
      if(hit) return {exists:true,contactId:hit.id,matchedOn:'phone'};
    }
  }catch(e){
    return {exists:false,lookupError:e.message};
  }
  return {exists:false};
}

async function discoverGoallProspectsWithOutscraper(plan,rocketReachMode){
  const jobs=buildGoallSearchJobs(plan);
  const requested=plan.requestedViableLeads;
  const perSearchLimit=Math.min(50,Math.max(12,Math.ceil(Math.min(GOALL_LEAD_RAW_SEARCH_MAX,requested*4)/Math.max(1,Math.min(jobs.length,GOALL_LEAD_SEARCH_CALLS_MAX)))));
  const raw=[];
  const errors=[];
  let configured=true;
  let rawCount=0;
  const duplicateKeys=new Set();
  const rejectedReasons={duplicate:0,already_in_crm:0,missing_email_and_phone:0,bad_fit:0};
  const scrapeJob=async(job)=>{
    const scraped=await discoverOutscraperProspects({
      organizationType:job.industry,
      employeeMinimum:plan.employeeMinimum,
      market:job.market,
      limit:perSearchLimit,
      leadProfile:plan.leadProfile
    }).catch(e=>({configured:!!OUTSCRAPER_API_KEY,leads:[],error:e.message}));
    return {job,scraped};
  };
  const mergeScraped=({job,scraped})=>{
    configured=!!scraped.configured;
    if(scraped.error) errors.push(`${job.industry} in ${job.market}: ${scraped.error}`);
    rawCount += scraped.rawCount || (scraped.leads||[]).length;
    for(const lead of scraped.leads||[]){
      if(raw.length>=GOALL_LEAD_RAW_SEARCH_MAX) break;
      const enrichedIndustry=lead.aiExactIndustry||lead.industry||job.industry;
      const next={...lead,organizationType:job.industry,industry:enrichedIndustry,aiExactIndustry:enrichedIndustry,searchMarket:job.market,leadProfile:plan.leadProfile};
      const key=goallLeadKey(next);
      if(duplicateKeys.has(key)){
        rejectedReasons.duplicate+=1;
        continue;
      }
      duplicateKeys.add(key);
      raw.push(next);
    }
  };
  // Run all search jobs with bounded concurrency instead of one-at-a-time sequential awaits.
  // fastSearch jobs (already a small slice) still run fully in parallel.
  if(plan.fastSearch){
    const scrapeResults=await Promise.all(jobs.map(scrapeJob));
    const missing=scrapeResults.find(result=>!result.scraped.configured);
    if(missing) return {configured:false,leads:[],rawCount,error:missing.scraped.error};
    scrapeResults.forEach(mergeScraped);
  }else{
    const scrapeResults=await mapWithConcurrency(jobs,GOALL_LEAD_JOB_CONCURRENCY,scrapeJob);
    const missing=scrapeResults.find(result=>!result.scraped.configured);
    if(missing) return {configured:false,leads:[],rawCount,error:missing.scraped.error};
    scrapeResults.forEach(mergeScraped);
  }
  // Filter out leads that already exist in the GHL CRM (by email or phone) before spending
  // enrichment calls (website scrape, Apollo, RocketReach) on them.
  const crmChecked=await mapWithConcurrency(raw,GOALL_CRM_DEDUPE_CONCURRENCY,async lead=>{
    const dup=await checkCrmDuplicate(lead);
    return {lead,dup};
  });
  let freshLeads=[];
  for(const {lead,dup} of crmChecked){
    if(dup.exists){
      rejectedReasons.already_in_crm+=1;
      continue;
    }
    freshLeads.push(lead);
  }
  // If CRM-dedupe filtered out a large share of the batch, run one bounded top-up pass
  // (higher per-search limit, same jobs) so the user still gets close to what they asked for.
  if(freshLeads.length<requested && freshLeads.length<raw.length){
    const topUpLimit=Math.min(50,perSearchLimit*2);
    const topUpResults=await mapWithConcurrency(jobs,GOALL_LEAD_JOB_CONCURRENCY,async job=>{
      const scraped=await discoverOutscraperProspects({
        organizationType:job.industry,
        employeeMinimum:plan.employeeMinimum,
        market:job.market,
        limit:topUpLimit,
        leadProfile:plan.leadProfile
      }).catch(e=>({configured:!!OUTSCRAPER_API_KEY,leads:[],error:e.message}));
      return {job,scraped};
    });
    topUpResults.forEach(mergeScraped);
    const newRaw=raw.slice(crmChecked.length);
    if(newRaw.length){
      const newChecked=await mapWithConcurrency(newRaw,GOALL_CRM_DEDUPE_CONCURRENCY,async lead=>{
        const dup=await checkCrmDuplicate(lead);
        return {lead,dup};
      });
      for(const {lead,dup} of newChecked){
        if(dup.exists){
          rejectedReasons.already_in_crm+=1;
          continue;
        }
        freshLeads.push(lead);
      }
    }
  }
  const enrichLimit=Math.min(freshLeads.length,GOALL_LEAD_RAW_SEARCH_MAX);
  const enrichmentConcurrency=requested>=100?10:(requested>=25?6:3);
  const enriched=await mapWithConcurrency(freshLeads.slice(0,Math.min(enrichLimit,requested)),enrichmentConcurrency,async prospect=>{
    const next=await enrichProspect(prospect,{rocketReachMode,fastPreview:plan.fastSearch}).catch(e=>({...prospect,rocketReachStatus:e.message}));
    const exactIndustry=next.aiExactIndustry||next.industry||next.organizationType||prospect.organizationType||'unclear';
    return applyLeadScoring({...next,aiExactIndustry:exactIndustry,leadProfile:plan.leadProfile});
  });
  const viable=[];
  for(const lead of enriched){
    viable.push(lead);
  }
  viable.sort(sortGoallLeads);
  return {
    configured:true,
    leads:viable.slice(0,requested),
    rawCount,
    errors,
    rejectedReasons,
    jobs
  };
}

async function fetchTextWithTimeout(url,timeoutMs=3500){
  const controller = new AbortController();
  const timer = setTimeout(()=>controller.abort(),timeoutMs);
  try{
    const response = await fetch(url,{signal:controller.signal,headers:{'User-Agent':'Mozilla/5.0 VAL lead research'}});
    if(!response.ok) return '';
    const type=response.headers.get('content-type')||'';
    if(type && !/text|html|json/i.test(type)) return '';
    return (await response.text()).slice(0,250000);
  }catch(_){
    return '';
  }finally{
    clearTimeout(timer);
  }
}

function candidateContactUrls(website){
  if(!website) return [];
  try{
    const base = new URL(website);
    const origin = base.origin;
    return [...new Set([
      base.href,
      new URL('/contact',origin).href,
      new URL('/contact-us',origin).href,
      new URL('/about',origin).href,
      new URL('/about-us',origin).href,
      new URL('/team',origin).href,
      new URL('/staff',origin).href,
      new URL('/leadership',origin).href,
      new URL('/our-team',origin).href,
      new URL('/meet-the-team',origin).href,
      new URL('/management',origin).href,
      new URL('/leadership-team',origin).href,
      new URL('/about/team',origin).href,
      new URL('/team-members',origin).href,
      new URL('/staff-directory',origin).href,
      new URL('/careers',origin).href,
      new URL('/jobs',origin).href,
      new URL('/services',origin).href,
      new URL('/locations',origin).href,
      new URL('/people',origin).href,
      new URL('/who-we-are',origin).href
    ])];
  }catch(_){
    return [];
  }
}

function bestEmail(candidates){
  const unique=[...new Map(candidates.filter(c=>c.email).map(c=>[c.email.toLowerCase(),{...c,email:c.email.toLowerCase(),quality:classifyEmail(c.email)}])).values()];
  const score={person:4,'high-value role':3,general:2,missing:0};
  unique.sort((a,b)=>(score[b.quality]||0)-(score[a.quality]||0));
  return unique[0]||{email:'',source:'',quality:'missing'};
}

function extractLeadership(text){
  const clean=String(text||'').replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ');
  const titles=[
    'Chief Executive Officer','CEO','Founder','Co-Founder','Owner','President',
    'Managing Partner','Partner','Principal','Practice Owner','Office Manager',
    'Executive Director','Administrator','Clinic Director','Managing Director',
    'General Manager','Operations Manager','Director of Operations',
    'Chief Operating Officer','COO','HR Director','Human Resources Director',
    'Benefits Manager','Sales Director','VP Sales','Vice President of Sales',
    'Partnerships Director','Director','Controller'
  ];
  const titlePattern=titles.map(t=>t.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|');
  const namePattern="([A-Z][A-Za-z.'’\\-]+(?:\\s+[A-Z][A-Za-z.'’\\-]+){1,3})";
  const candidates=[];
  const addCandidate=(name,title,index)=>{
    const cleanedName=String(name||'').replace(/\s+/g,' ').trim();
    const cleanedTitle=String(title||'').replace(/\s+/g,' ').trim();
    if(!cleanedName || !cleanedTitle) return;
    if(/\b(Contact|About|Services|Careers|Team|Leadership|Office|Phone|Email|Fax|Address|Click|Learn|Read|More|Home)\b/i.test(cleanedName)) return;
    const words=cleanedName.split(/\s+/);
    if(words.length<2 || words.length>4) return;
    const titleScore={
      'CEO':100,
      'Chief Executive Officer':100,
      'Owner':95,
      'Founder':95,
      'Co-Founder':92,
      'President':90,
      'Managing Partner':88,
      'Partner':80,
      'Principal':78,
      'Practice Owner':78,
      'Executive Director':75,
      'Managing Director':72,
      'Director of Operations':70,
      'Chief Operating Officer':70,
      'COO':70,
      'General Manager':65,
      'Office Manager':55,
      'Administrator':50
    }[cleanedTitle] || 40;
    candidates.push({name:cleanedName,title:cleanedTitle,score:titleScore-(index/10000)});
  };
  const titleFirst=new RegExp(`\\b(${titlePattern})\\b\\s*(?:[:\\-–|,]|\\s+for\\s+)?\\s*${namePattern}`,'gi');
  const nameFirst=new RegExp(`\\b${namePattern}\\s*(?:[,\\-–|]+|\\s+-\\s+|\\s+is\\s+(?:the\\s+)?)\\s*(${titlePattern})\\b`,'gi');
  let m;
  while((m=titleFirst.exec(clean)) && candidates.length<20) addCandidate(m[2],m[1],m.index);
  while((m=nameFirst.exec(clean)) && candidates.length<40) addCandidate(m[1],m[2],m.index);
  candidates.sort((a,b)=>b.score-a.score);
  if(candidates[0]) return {name:candidates[0].name,title:candidates[0].title};
  return {name:'',title:''};
}

async function findPublicWebsiteContactData(website){
  const urls = candidateContactUrls(website);
  const emails=[];
  let leader={name:'',title:''};
  for(const url of urls){
    const text = await fetchTextWithTimeout(url);
    extractEmailsFromValue(text).forEach(email=>emails.push({email,source:url}));
    if(!leader.name){
      const found=extractLeadership(text);
      if(found.name) leader={...found,source:url};
    }
    const currentBest=bestEmail(emails);
    if(currentBest.quality==='person' && leader.name) break;
  }
  return {...bestEmail(emails),leader};
}

async function findPublicWebsiteEmail(website){
  const data=await findPublicWebsiteContactData(website);
  return {email:data.email,source:data.source,quality:data.quality};
}

async function mapWithConcurrency(items,limit,fn){
  const out = new Array(items.length);
  let index = 0;
  const workers = Array.from({length:Math.min(limit,items.length)},async()=>{
    while(index<items.length){
      const current = index++;
      out[current] = await fn(items[current],current);
    }
  });
  await Promise.all(workers);
  return out;
}

async function discoverHbsLeadProspects(body={}){
  const plan=resolveGoallLeadSearchPlan(body);
  const {market,criteria,organizationType,employeeMinimum,tag}=plan;
  const limit=plan.requestedViableLeads;
  const rocketReachMode=String(body.rocketReachMode||body.rocketreachMode||'').trim() || (limit<=25?'auto':'defer');
  const scraped=await discoverGoallProspectsWithOutscraper(plan,rocketReachMode).catch(e=>({configured:!!OUTSCRAPER_API_KEY,leads:[],error:e.message,rejectedReasons:{}}));
  if(!scraped.configured){
    return {ok:false,market,criteria,organizationType,employeeMinimum,tag,leads:[],scraped,raw:'',rocketReachMode,searchPlan:plan,report:{requestedViableLeads:limit,viableLeads:0,rawCount:0},error:scraped.error||'Outscraper is not configured',content:leadDiscoveryFailureText({plan,scraped})};
  }
  let leads=scraped.leads||[];
  let raw='';
  let webError='';
  if(!leads.length){
    const allowWebFallback=!plan.fastSearch || /^(1|true|yes)$/i.test(String(body.allowWebFallback||body.allow_web_fallback||''));
    if(!allowWebFallback){
      webError='';
    }else{
      const brand=plan.leadBrand||'GOALL';
      const system=[
        GOALL_LEADS_SYSTEM_PROMPT,
        `Discovery mode: find potential ${brand} business leads and return machine-readable JSON only.`,
        'Find companies with visible evidence of employee size, hiring, growth, operational complexity, and reachable decision-makers.',
        'A viable lead is a non-duplicate business that matches the requested profile. Email and phone are preferred but not required for import.',
        `Search across the requested industry set. If the user asked for broad ${brand} leads, use the matching ${brand} priority industries.`,
        brand==='Westwood'?'Use RocketReach for enrichment. Do not use Apollo. Exclude government, municipal, public department, and clearly public-school results unless explicitly requested.':'',
        'Do not invent exact employee counts. approximateDonors is being used as the legacy numeric field for approximate employees and must be a conservative integer estimate from public signals.',
        'Return ONLY valid JSON. No markdown. No commentary.'
      ].filter(Boolean).join('\n\n');
      const user=[
        `Find ${limit} viable business prospects for ${brand}.`,
        `Market: ${market}`,
        `Industries: ${plan.industries.join(', ')}`,
        `Minimum employees: ${employeeMinimum}`,
        `Criteria: ${criteria}`,
        'Do not reject a prospect solely because email, phone, or decision-maker name is missing.',
        '',
        'Return JSON with this exact shape:',
        '{"leads":[{"organizationName":"","website":"","industry":"","aiExactIndustry":"","leadScore":1,"leadScoreReason":"","automationTag":"","automationTagReason":"","normalizedIndustry":"","rawIndustry":"","tagConfidence":"","needsNewAutomation":false,"suggestedNewAutomationTag":"","primaryService":"","location":"","city":"","state":"","organizationType":"","partnerFit":"","approximateDonors":0,"estimatedEmployeeCount":"","employeeCountConfidence":"","employeeCountNote":"","donorEstimateBasis":"","evidenceSignals":[""],"growthSignals":"","leadershipSignals":"","workforcePainSignals":"","engagementActivitySignals":"","decisionMakerName":"","decisionMakerTitle":"","decisionMakerEmail":"","decisionMakerPhone":"","decisionMakerLinkedin":"","email":"","phone":"","linkedinPersonalUrl":"","linkedinCompanyUrl":"","companyLinkedin":"","hiringActivity":"","careersPage":"","growthActivity":"","operationalActivity":"","socialActivity":"","operationalIndicators":"","weakFitConcerns":"","googleRaw":"","newsRaw":"","goallIntelligenceNote":"","recommendedFirstCallAngle":"","missingData":"","nextOutreachAngle":"","confidence":""}]}'
      ].join('\n');
      try{
        raw=await callOpenAIWebResearch({system,user,maxTokens:6000,temperature:0.15});
        let candidates=extractJsonArray(raw).slice(0,GOALL_LEAD_RAW_SEARCH_MAX);
        // Same CRM-dedupe as the Outscraper path: skip leads already in GHL before
        // spending enrichment calls (Apollo/RocketReach/website lookups) on them.
        const candidateChecks=await mapWithConcurrency(candidates,GOALL_CRM_DEDUPE_CONCURRENCY,async lead=>{
          const dup=await checkCrmDuplicate(lead);
          return {lead,dup};
        });
        let webRejectedDuplicates=0;
        candidates=candidateChecks.filter(({dup})=>{
          if(dup.exists){ webRejectedDuplicates+=1; return false; }
          return true;
        }).map(({lead})=>lead);
        leads=await mapWithConcurrency(candidates,5,p=>enrichProspect({...p,organizationType:p.organizationType||organizationType,approximateDonors:p.approximateDonors||0},{rocketReachMode}));
        leads=leads
          .map(p=>{
            const exactIndustry=p.aiExactIndustry||p.ai_exact_industry||p.industry||p.organizationType||'unclear';
            return applyLeadScoring({...p,aiExactIndustry:exactIndustry,leadProfile:plan.leadProfile});
          })
          .sort(sortGoallLeads)
          .slice(0,limit);
        if(webRejectedDuplicates) scraped.rejectedReasons={...(scraped.rejectedReasons||{}),already_in_crm:(scraped.rejectedReasons?.already_in_crm||0)+webRejectedDuplicates};
      }catch(e){
        webError=e.message||'upstream error';
      }
    }
  }
  if(!leads.length){
    return {ok:false,market,criteria,organizationType,employeeMinimum,tag,leads:[],scraped,raw,rocketReachMode,searchPlan:plan,report:{requestedViableLeads:limit,viableLeads:0,rawCount:scraped.rawCount||0},error:webError||scraped.error||'No leads were found',content:leadDiscoveryFailureText({plan,scraped,webError})};
  }
  const rejectedReasons=scraped.rejectedReasons||{};
  const report=summarizeGoallDiscovery({
    requested:limit,
    leads,
    rawCount:scraped.rawCount||leads.length,
    industries:plan.industries,
    cities:plan.cities,
    rejectedReasons
  });
  return {ok:true,market,criteria,organizationType,employeeMinimum,tag,leads,scraped,raw,rocketReachMode,searchPlan:plan,report};
}

function cleanLeadLevelText(value){
  return String(value||'')
    .replace(/ROCKETREACH_API_KEY|OUTSCRAPER_API_KEY|APOLLO_API_KEY/gi,'integration connection')
    .replace(/Outscraper/gi,'Level 1')
    .replace(/Apollo/gi,'Level 2')
    .replace(/RocketReach/gi,'Level 3')
    .replace(/api[_ -]?key/gi,'connection');
}

function leadDiscoveryFailureText({plan,scraped,webError}={}){
  const brand=plan?.leadBrand||'GOALL';
  return [
    `Lead scrape could not complete for ${brand}.`,
    '',
    `Search: ${plan?.organizationType||plan?.criteria||'requested lead profile'} | ${plan?.employeeMinimum||10}+ employees | ${plan?.market||'selected market'}`,
    '',
    'What happened:',
    scraped?.error?`- Level 1 map/business search returned: ${cleanLeadLevelText(scraped.error)}`:'',
    Array.isArray(scraped?.errors)&&scraped.errors.length?`- Search notes: ${scraped.errors.slice(0,3).map(cleanLeadLevelText).join(' | ')}`:'',
    webError?`- Web research fallback returned: ${cleanLeadLevelText(webError)}`:'',
    '',
    'Try this next:',
    '- Run a smaller test batch, like 12 leads.',
    '- Use one specific industry and city, for example "HVAC companies in Phoenix".',
    '- Open Register Your Keys and test Outscraper and OpenAI if this happens on every search.'
  ].filter(Boolean).join('\n');
}

function leadDiscoveryErrorPayload(body,error){
  let plan=null;
  try{ plan=resolveGoallLeadSearchPlan(body||{}); }catch(_){}
  const scraped={configured:true,leads:[],rawCount:0,error:error?.message||String(error||'upstream error')};
  const market=plan?.market||body?.market||'selected market';
  const criteria=plan?.criteria||body?.criteria||body?.organizationType||'requested lead profile';
  const organizationType=plan?.organizationType||body?.organizationType||criteria;
  const employeeMinimum=plan?.employeeMinimum||body?.employeeMinimum||10;
  const tag=plan?.tag||body?.tag||'';
  return {
    ok:false,
    market,
    criteria,
    organizationType,
    employeeMinimum,
    tag,
    leads:[],
    scraped,
    raw:'',
    rocketReachMode:body?.rocketReachMode||body?.rocketreachMode||'auto',
    searchPlan:plan||{criteria,market,organizationType,employeeMinimum,leadBrand:body?.leadProfile==='westwood'?'Westwood':'GOALL'},
    report:{requestedViableLeads:Number(body?.limit)||12,viableLeads:0,rawCount:0},
    error:scraped.error,
    content:leadDiscoveryFailureText({plan:plan||{criteria,market,organizationType,employeeMinimum,leadBrand:body?.leadProfile==='westwood'?'Westwood':'GOALL'},scraped,webError:scraped.error})
  };
}

function leadPreviewText(discovered){
  const leads=(discovered.leads||[]).map(sanitizeDecisionMaker).map(applyLeadScoring).sort(sortGoallLeads);
  const brand=discovered.searchPlan?.leadBrand || (discovered.leadProfile==='westwood'?'Westwood':'GOALL');
  const automationSummary=brand==='GOALL'?summarizeGoallAutomationTags(leads):null;
  const automationLines=automationSummary?Object.entries(automationSummary.tagCounts).filter(([,count])=>count>0).map(([tag,count])=>`${tag}: ${count}`):[];
  const suggestedAutomationLines=automationSummary?Object.entries(automationSummary.suggestedCounts).filter(([,count])=>count>0).map(([tag,count])=>`${tag}: ${count}`):[];
  const report=discovered.report||summarizeGoallDiscovery({
    requested:leads.length,
    leads,
    rawCount:discovered.scraped?.rawCount||leads.length,
    industries:discovered.searchPlan?.industries||[discovered.organizationType].filter(Boolean),
    cities:discovered.searchPlan?.cities||[],
    rejectedReasons:discovered.scraped?.rejectedReasons||{}
  });
  const level1Status=p=>{
    const hasBusiness=!!(p.organizationName||p.name);
    const hasWebsite=!!p.website;
    return hasBusiness ? `business matched${hasWebsite?' with website':' with public listing'}` : 'business match unclear';
  };
  const level2Status=p=>{
    if(p.decisionMakerName) return `decision-maker matched${p.decisionMakerTitle?' - '+p.decisionMakerTitle:''}`;
    if(p.apolloStatus) return cleanLeadLevelText(p.apolloStatus);
    return 'decision-maker not confirmed yet';
  };
  const level3Status=p=>{
    const c=leadContactability(p);
    if(c.contactabilityStatus==='full_contactability') return 'email and phone verified or available';
    if(c.contactabilityStatus==='email_only') return 'email available, phone not confirmed';
    if(c.contactabilityStatus==='phone_only') return 'phone available, email not confirmed';
    if(p.rocketReachStatus) return cleanLeadLevelText(p.rocketReachStatus);
    return 'contact method not confirmed';
  };
  return [
    `Found and enriched ${leads.length} viable ${brand} lead${leads.length===1?'':'s'}.`,
    `Search: ${discovered.organizationType} | ${discovered.employeeMinimum}+ employees | ${discovered.market}`,
    `Requested viable leads: ${report.requestedViableLeads}`,
    `Viable found: ${report.viableLeadsFound} | Full: ${report.fullContactability} | Email only: ${report.emailOnly} | Phone only: ${report.phoneOnly} | No contact method: ${report.noContact||0}`,
    brand==='GOALL'?`Pipeline volume standard: ${report.viableLeadsFound}/${GOALL_PIPELINE_MINIMUM} people/prospects found in this batch. ${report.pipelineVolumeStatus==='sufficient'?'Minimum met.':'Not enough yet.'}`:'',
    brand==='GOALL'&&report.pipelineVolumeWarning?report.pipelineVolumeWarning:'',
    'Lead Score Breakdown:',
    `1 - Highest Priority: ${report.score1Count||0}`,
    `2 - Strong Fit: ${report.score2Count||0}`,
    `3 - Possible Fit: ${report.score3Count||0}`,
    `4 - Low Fit: ${report.score4Count||0}`,
    `Raw businesses searched: ${report.rawBusinessesSearched}`,
    report.industriesSearched?.length?`Industries searched: ${report.industriesSearched.slice(0,12).join(', ')}${report.industriesSearched.length>12?' +' + (report.industriesSearched.length-12) + ' more':''}`:'',
    report.citiesSearched?.length?`Arizona city coverage: ${report.citiesSearched.slice(0,8).join(', ')}${report.citiesSearched.length>8?' +' + (report.citiesSearched.length-8) + ' more':''}`:'',
    brand==='GOALL'?'Automation tags are assigned per lead and control which GHL automation should run.':`Recommended tag: ${discovered.tag}`,
    automationLines.length?'Automation Tag Breakdown:\n'+automationLines.join('\n'):'',
    suggestedAutomationLines.length?'Suggested New Automations:\n'+suggestedAutomationLines.join('\n'):'',
    discovered.rocketReachMode==='defer'?'Level 3: deferred for this broad scrape. Use it after review on the leads that need person-level verification.':'',
    discovered.scraped?.error?`Level 1 note: ${cleanLeadLevelText(discovered.scraped.error)}`:'',
    discovered.scraped?.errors?.length?`Search notes: ${discovered.scraped.errors.slice(0,3).map(cleanLeadLevelText).join(' | ')}`:'',
    '',
    leads.map((p,i)=>{
      p=applyLeadScoring(p);
      const automation=brand==='GOALL'?mapGoallAutomationTag(p):{};
      const donorCount=donorValue(p.approximateDonors||p.estimatedDonors||p.donorCount);
      const contactability=leadContactability(p);
      const goallIntel=brand==='GOALL'?buildGoallIntelligenceProfile(p,p.aiExactIndustry||p.ai_exact_industry||p.industry||p.organizationType||'business'):null;
      return [
        `${i+1}. ${p.organizationName||p.name||'Unnamed organization'}`,
        `   Industry: ${p.aiExactIndustry||p.ai_exact_industry||p.industry||p.organizationType||'unclear'}`,
        `   Lead Score: ${p.leadScore} (${p.leadScore===1?'Highest Priority':p.leadScore===2?'Strong Fit':p.leadScore===3?'Possible Fit':'Low Fit'})`,
        `   Lead Score Reason: ${p.leadScoreReason}`,
        goallIntel?`   Recommended First Call Angle: ${goallIntel.firstCall}`:'',
        automation.automationTag?`   Automation Tag: ${automation.automationTag}`:'',
        automation.tagConfidence?`   Tag Confidence: ${automation.tagConfidence}`:'',
        automation.automationTag?`   Needs New Automation: ${automation.needsNewAutomation?'yes':'no'}`:'',
        automation.suggestedNewAutomationTag?`   Suggested New Automation: ${automation.suggestedNewAutomationTag}`:'',
        `   Location: ${p.location||[p.city,p.state].filter(Boolean).join(', ')||'unclear'}`,
        `   Website: ${p.website||'unclear'}`,
        `   Phone: ${p.phone||'unclear'}`,
        `   Email: ${p.email||'missing'}${p.emailSource?' (from '+p.emailSource+')':''}${p.emailQuality?' ['+p.emailQuality+']':''}`,
        `   Contactability: ${contactability.contactabilityStatus}`,
        `   Outreach: ${leadContactabilityNote(contactability)}`,
        `   Decision maker: ${p.decisionMakerName||'unclear'}${p.decisionMakerTitle?' - '+p.decisionMakerTitle:''}`,
        `   Employee estimate: ${goallIntel?.employee?.count||donorCount||'unclear'}${goallIntel?.employee?.confidence?' ('+goallIntel.employee.confidence+')':''}`,
        goallIntel?`   Growth signals: ${goallIntel.signals.growth}`:'',
        goallIntel?`   Workforce signals: ${goallIntel.signals.workforce}`:'',
        goallIntel?`   Leadership signals: ${goallIntel.signals.leadership}`:'',
        goallIntel?`   Lead Intelligence Summary: ${goallIntel.note.replace(/\n/g,' | ')}`:'',
        `   ${brand} fit: ${p.goallFitScore||'unclear'}${p.goallFitReason?' - '+p.goallFitReason:''}`,
        `   Evidence: ${Array.isArray(p.evidenceSignals)?p.evidenceSignals.slice(0,4).join('; '):(p.evidenceSignals||p.donorEstimateBasis||'unclear')}`,
        `   Level 1: ${level1Status(p)}`,
        `   Level 2: ${level2Status(p)}`,
        `   Level 3: ${level3Status(p)}`
      ].join('\n');
    }).join('\n\n'),
    '',
    'Review these first. Import only after approval.'
  ].filter(Boolean).join('\n');
}

function ghlContactMatchText(contact={}){
  return [
    contact.id,
    contact.email,
    contact.phone,
    contact.name,
    contact.contactName,
    contact.firstName,
    contact.lastName,
    contact.companyName,
    contact.businessName,
    contact.website,
    contact.linkedinUrl,
    contact.linkedin,
    contact.customFields?.map?.(field=>field.field_value||field.value||'').join(' ')
  ].filter(Boolean).join(' ').toLowerCase();
}

function leadDuplicateNeedles(p={}){
  return [
    validEmail(p.email)?String(p.email).toLowerCase().trim():'',
    validPhone(p.phone)?String(p.phone).replace(/\D/g,''):'',
    leadDomain(p.website||''),
    normalizeCompanyForMatch(p.organizationName||p.name||''),
    String(p.linkedinPersonalUrl||p.linkedinCompanyUrl||p.linkedinUrl||'').toLowerCase().trim()
  ].filter(Boolean);
}

async function findExistingGhlLeadDuplicate(p={}){
  const queries=[
    validEmail(p.email)?String(p.email).trim():'',
    validPhone(p.phone)?String(p.phone).trim():'',
    leadDomain(p.website||''),
    p.organizationName||p.name||'',
    p.linkedinPersonalUrl||p.linkedinCompanyUrl||p.linkedinUrl||''
  ].filter(Boolean);
  const needles=leadDuplicateNeedles(p);
  if(!queries.length || !needles.length) return null;
  const locationId=await resolveGhlLocationId();
  for(const q of queries.slice(0,3)){
    const data=await ghlStrict('GET',`/contacts/?locationId=${encodeURIComponent(locationId||GHL_LOC||'')}&query=${encodeURIComponent(q)}&limit=10`).catch(()=>null);
    const contacts=data?.contacts||data?.data||[];
    for(const contact of contacts){
      const hay=ghlContactMatchText(contact);
      const hayPhone=String(contact.phone||'').replace(/\D/g,'');
      const matched=needles.some(needle=>{
        if(!needle) return false;
        if(/^\d{7,}$/.test(needle)) return hayPhone && hayPhone===needle;
        return hay.includes(String(needle).toLowerCase());
      });
      if(matched) return {id:contact.id,name:contact.contactName||contact.name||[contact.firstName,contact.lastName].filter(Boolean).join(' ')||contact.companyName||q,match:q};
    }
  }
  return null;
}

function opportunityContactId(o={}){
  return String(o.contactId||o.contact_id||o.contact?.id||o.contact?.contactId||o.contact?._id||'');
}

async function findOpenOpportunityForContact(contactId){
  const id=String(contactId||'').trim();
  if(!id) return null;
  const data=await fetchGhlOpportunities({status:'open',limit:100}).catch(()=>({opportunities:[]}));
  const opportunities=data.data?.opportunities||data.opportunities||[];
  return opportunities.find(o=>opportunityContactId(o)===id)||null;
}

async function ensureGhlOpportunityForExistingLead(lead,duplicate,discovered,automation={}){
  const contactId=duplicate?.id;
  if(!contactId) return {created:false, reason:'duplicate contact id missing'};
  const isGoall=(discovered.searchPlan?.leadBrand==='GOALL'||discovered.leadProfile==='goall');
  if(isGoall){
    const leadFields=leadCustomFieldsFromProspect({...lead,...automation});
    const leadFieldIds=await resolveLeadFieldIds().catch(()=>GHL_LEAD_FIELD_IDS);
    await assertGoallLeadScoreField(leadFieldIds);
    await updateGhlLeadFields(contactId,leadFields);
  }
  const existing=await findOpenOpportunityForContact(contactId);
  if(existing) return {created:false, existing:true, opportunity:existing, contactId};
  const target=await getOpportunityTarget();
  const donorCount=donorValue(lead.approximateDonors||lead.estimatedDonors||lead.donorCount);
  const source=(lead.leadProfile||'').toLowerCase()==='westwood'?'Grace Intelligence Limitless Leads':'LimitLess Leads';
  const name=lead.organizationName||lead.name||duplicate.name||'Existing business lead';
  const opportunityPayload={
    locationId:GHL_LOC,
    pipelineId:target.pipelineId,
    pipelineStageId:target.stageId,
    name,
    status:'open',
    contactId,
    monetaryValue:donorCount||0,
    source
  };
  const opportunityData=await createGhlOpportunity(opportunityPayload);
  const tags=isGoall
    ? [automation.automationTag,'Employer','GOALL Lead','Limitless Leads'].filter(Boolean)
    : [discovered.tag||'limitless_enrich','Employer'].filter(Boolean);
  if(tags.length) await ghlStrict('POST',`/contacts/${contactId}/tags`,{tags}).catch(()=>{});
  return {created:true, contactId, opportunity:opportunityData.opportunity||opportunityData,pipelineId:target.pipelineId,stageId:target.stageId,pipelineName:target.pipelineName||'',stageName:target.stageName||''};
}

async function importApprovedHbsLeads(discovered){
  const {market,criteria,organizationType,employeeMinimum,tag,scraped}=discovered;
  const brand=discovered.searchPlan?.leadBrand || (discovered.leadProfile==='westwood'?'Westwood':'GOALL');
  const leads=Array.isArray(discovered.leads)?discovered.leads.map(sanitizeDecisionMaker).map(applyLeadScoring).sort(sortGoallLeads):[];
  if(!leads.length) throw new Error('No importable leads returned. Try a more specific market or criteria.');
  const created=[];
  const failed=[];
  const skipped=[];
  await mapWithConcurrency(leads,GOALL_LEAD_IMPORT_CONCURRENCY,async lead=>{
    const automation=brand==='GOALL'?mapGoallAutomationTag(lead):{};
    if(brand==='GOALL' && !automation.automationTag){
      skipped.push({name:lead.organizationName||lead.name||'Unknown lead',reason:'missing_automation_tag'});
      return;
    }
    const contactability=leadContactability(lead);
    const goallIntel=brand==='GOALL'?buildGoallIntelligenceProfile(lead,lead.aiExactIndustry||lead.ai_exact_industry||lead.industry||lead.organizationType||'business'):null;
    if(brand==='GOALL' && !contactability.importable && !strongGoallManualReviewLead(lead,goallIntel)){
      skipped.push({name:lead.organizationName||lead.name||'Unknown lead',reason:'missing_email_and_phone'});
      return;
    }
    try{
      const duplicate=await findExistingGhlLeadDuplicate(lead);
      if(duplicate){
        const repaired=await ensureGhlOpportunityForExistingLead(lead,duplicate,discovered,automation).catch(e=>({created:false,error:e.message}));
        skipped.push({
          name:lead.organizationName||lead.name||'Unknown lead',
          reason:'duplicate',
          contactId:duplicate.id,
          matched:duplicate.match,
          opportunityCreated:!!repaired.created,
          opportunityExisting:!!repaired.existing,
          opportunityError:repaired.error||''
        });
        return;
      }
      created.push(await createGhlLeadFromProspect({...lead,...automation,tag,organizationType:lead.organizationType||organizationType,approximateDonors:lead.approximateDonors||0},{tag}));
    }catch(e){
      failed.push({name:lead.organizationName||lead.name||'Unknown lead',error:e.message});
    }
  });
  const automationSummary=brand==='GOALL'?summarizeGoallAutomationTags(leads):null;
  const automationLines=automationSummary?Object.entries(automationSummary.tagCounts).filter(([,count])=>count>0).map(([automationTag,count])=>`${automationTag}: ${count}`):[];
  const suggestedAutomationLines=automationSummary?Object.entries(automationSummary.suggestedCounts).filter(([,count])=>count>0).map(([automationTag,count])=>`${automationTag}: ${count}`):[];
  const duplicateCount=skipped.filter(s=>s.reason==='duplicate').length;
  const repairedOpportunityCount=skipped.filter(s=>s.opportunityCreated).length;
  const existingOpportunityCount=skipped.filter(s=>s.opportunityExisting).length;
  const pipelineProgress=created.length+repairedOpportunityCount+existingOpportunityCount;
  const summary=[
    `Imported ${created.length} new ${brand} business lead${created.length===1?'':'s'} to GHL.`,
    `Search: ${organizationType} | ${employeeMinimum}+ employees | ${market}`,
    brand==='GOALL'?'Tags applied: Employer + per-lead automation tag + GOALL Lead + Limitless Leads':`Tags applied: ${tag} + Employer`,
    duplicateCount?`Already in GHL: ${duplicateCount} matching contact${duplicateCount===1?'':'s'} found, so those were not duplicated.`:'',
    repairedOpportunityCount?`Repaired opportunities: ${repairedOpportunityCount} missing opportunit${repairedOpportunityCount===1?'y was':'ies were'} created for existing contact${repairedOpportunityCount===1?'':'s'}.`:'',
    existingOpportunityCount?`Existing opportunities: ${existingOpportunityCount} contact${existingOpportunityCount===1?' already has':'s already have'} an open opportunity.`:'',
    brand==='GOALL'?`Pipeline volume standard: ${pipelineProgress}/${GOALL_PIPELINE_MINIMUM} people/prospects represented in this batch (${created.length} new + ${repairedOpportunityCount} repaired + ${existingOpportunityCount} already open). ${pipelineProgress>=GOALL_PIPELINE_MINIMUM?'Minimum met.':'Not enough yet.'}`:'',
    brand==='GOALL'&&pipelineProgress<GOALL_PIPELINE_MINIMUM?`GOALL pipeline volume is insufficient. Fewer than ${GOALL_PIPELINE_MINIMUM} people/prospects is not enough; keep running focused batches until the pipeline reaches the minimum.`:'',
    automationLines.length?'Automation Tag Breakdown:\n'+automationLines.join('\n'):'',
    suggestedAutomationLines.length?'Suggested New Automations:\n'+suggestedAutomationLines.join('\n'):'',
    discovered.report?`Contactability: full ${discovered.report.fullContactability||0} | email only ${discovered.report.emailOnly||0} | phone only ${discovered.report.phoneOnly||0} | no contact method ${discovered.report.noContact||0}`:'',
    discovered.report?`Lead Score Breakdown: 1 - Highest Priority: ${discovered.report.score1Count||0} | 2 - Strong Fit: ${discovered.report.score2Count||0} | 3 - Possible Fit: ${discovered.report.score3Count||0} | 4 - Low Fit: ${discovered.report.score4Count||0}`:'',
    scraped?.error?`Level 1 note: ${cleanLeadLevelText(scraped.error)}`:'',
    skipped.length?`Skipped: ${skipped.length}`:'',
    failed.length?`Failed: ${failed.length}`:'',
    '',
    created.map(c=>`- ${c.name} | Lead Score: ${c.leadScore} | Contactability: ${c.contactabilityStatus}${c.contactabilityStatus==='phone_only'?' | Imported contact with phone only. No email was found, so the initial automated email sequence was not sent.':''} | Exact industry: ${c.aiExactIndustry||'unclear'}${c.automationTag?' | Automation: '+c.automationTag+' ('+c.tagConfidence+')':''} | Tags: ${(c.tags||[]).join(', ')} | Contact: ${c.contactId} | Opportunity value: $${c.value}${c.pipelineName||c.stageName?' | '+[c.pipelineName,c.stageName].filter(Boolean).join(' / '):''}${c.pipelineId?' | Pipeline ID: '+c.pipelineId:''}${c.stageId?' | Stage ID: '+c.stageId:''}${c.customFieldUpdate?.updated?'':' | Custom field warning: '+(c.customFieldUpdate?.reason||c.customFieldUpdate?.error||'not updated')}`).join('\n'),
    skipped.length?'\nSkipped / repaired leads:\n'+skipped.map(s=>`- ${s.name}: ${s.reason==='duplicate'?(s.opportunityCreated?'Matching GHL contact already existed; missing opportunity was created.':s.opportunityExisting?'Matching GHL contact already has an open opportunity.':'Skipped because a matching GHL contact already exists.'):s.reason==='missing_automation_tag'?'Contact was not imported because no GOALL automation tag could be assigned.':s.reason==='missing_email_and_phone'?'Contact was not imported because no email or phone was found and the company intelligence was not strong enough for manual review routing.':'Skipped before import.'} Reason: ${s.reason}${s.contactId?' | Existing contact: '+s.contactId:''}${s.opportunityError?' | Opportunity repair failed: '+s.opportunityError:''}`).join('\n'):'',
    failed.length?'\nFailed imports:\n'+failed.map(f=>`- ${f.name}: ${f.error}`).join('\n'):''
  ].filter(Boolean).join('\n');
  await saveMemoryItem({
    kind:brand==='Westwood'?'westwood_limitless_leads_import':'goall_limitless_leads_import',
    summary:`Imported ${created.length} ${brand} Limitless Leads prospects for ${organizationType} in ${market}`,
    rawText:summary+'\n\nRaw leads:\n'+JSON.stringify(leads,null,2),
    importance:3,
    metadata:{market,criteria,organizationType,employeeMinimum,tag,outscraper:scraped,created,failed,skipped}
  }).catch(()=>{});
  return {ok:true,created,failed,skipped,content:summary};
}

async function enrichProspectWithRocketReach(p){
  const rocketReachKey=await resolveIntegrationSecret('rocketreach','api_key',ROCKETREACH_API_KEY);
  if(!rocketReachKey) return {...p,rocketReachStatus:'ROCKETREACH_API_KEY is not set'};
  const rocket=await lookupRocketReachDecisionMaker(p.organizationName||p.name||'',p).catch(e=>({error:e.message}));
  const data=rocket?.data||{};
  const nextEmail=isLikelyPersonEmail(data.email) || !p.email ? data.email : p.email;
  const nextPhone=validPhone(data.phone) && !validPhone(p.phone) ? data.phone : p.phone;
  return {
    ...p,
    decisionMakerName:p.decisionMakerName||data.name||'',
    decisionMakerTitle:p.decisionMakerTitle||data.title||'',
    linkedinPersonalUrl:p.linkedinPersonalUrl||data.linkedinUrl||'',
    linkedinCompanyUrl:p.linkedinCompanyUrl||data.companyLinkedInUrl||'',
    linkedinCompanyId:p.linkedinCompanyId||data.companyId||'',
    linkedinEmployeeCount:p.linkedinEmployeeCount||data.employeeCount||'',
    linkedinCompanySizeBand:p.linkedinCompanySizeBand||data.companySizeBand||'',
    linkedinCompanyDescription:p.linkedinCompanyDescription||data.companyDescription||'',
    linkedinCompanyLocation:p.linkedinCompanyLocation||data.companyLocation||'',
    linkedinCompanyFoundedYear:p.linkedinCompanyFoundedYear||data.companyFoundedYear||'',
    linkedinProfileLocation:p.linkedinProfileLocation||data.location||'',
    linkedinMatchConfidence:data.name?'medium':'low',
    linkedinMatchNotes:rocket?.error || (data.name?`RocketReach matched ${data.name}${data.title?' - '+data.title:''}`:'RocketReach did not verify a decision maker'),
    email:nextEmail||p.email||'',
    phone:nextPhone||p.phone||'',
    rocketReach:rocket,
    rocketReachStatus:rocket?.error||data.rawPreview||'enriched'
  };
}

async function enrichProspect(p,opts={}){
  let next = {...p};
  const mode=opts.rocketReachMode||'auto';
  if(next.email && !next.emailQuality) next.emailQuality=classifyEmail(next.email);
  if(opts.fastPreview){
    return sanitizeDecisionMaker({
      ...next,
      apolloStatus:'deferred until review',
      rocketReachStatus:'deferred until review'
    });
  }
  if(next.website){
    const publicContact = await findPublicWebsiteContactData(next.website);
    if(publicContact.email && (!next.email || classifyEmail(publicContact.email)==='person' || (next.emailQuality==='general' && publicContact.quality==='high-value role'))){
      next.email = publicContact.email;
      next.emailSource = publicContact.source;
      next.emailQuality = publicContact.quality;
    }
    if(publicContact.leader?.name && !next.decisionMakerName){
      next.decisionMakerName = publicContact.leader.name;
      next.decisionMakerTitle = publicContact.leader.title || next.decisionMakerTitle || '';
      next.decisionMakerSource = publicContact.leader.source || '';
    }
  }
  if(mode==='defer'){
    next = await enrichProspectWithApollo(next);
    next.rocketReachStatus = 'deferred until review';
  }else{
    next = await enrichProspectWithApollo(next);
    next = await enrichProspectWithRocketReach(next);
  }
  if(next.email && !next.emailQuality) next.emailQuality=classifyEmail(next.email);
  return sanitizeDecisionMaker(next);
}

function enrichmentLevelSummaryLines(p,contactability=leadContactability(p)){
  const level1Ok=!!(p.organizationName||p.name);
  const level2Ok=!!(p.decisionMakerName||p.linkedinPersonalUrl);
  const rrStatus=String(p.rocketReachStatus||p.rocketReach?.error||'').toLowerCase();
  const rrData=p.rocketReach?.data||{};
  const level3Ok=!!(rrData.email||rrData.phone||rrData.name||rrData.linkedinUrl)
    || (contactability.importable && !/(no data|not available|not set|not found|did not|rate|error|failed|deferred|skipped)/i.test(rrStatus));
  return [
    `Enrichment Level 1 - ${level1Ok?'success':'no data found'}`,
    `Enrichment Level 2 - ${level2Ok?'success':'no data found'}`,
    `Enrichment Level 3 - ${level3Ok?'success':'no data found'}`
  ];
}

async function createGhlLeadFromProspect(p,opts={}){
  p=applyLeadScoring(p);
  p=sanitizeDecisionMaker({
    ...p,
    email:normalizeEmailAddress(p.email||p.decisionMakerEmail||p.decision_maker_email||''),
    phone:normalizePhoneNumber(p.phone||p.decisionMakerPhone||p.decision_maker_phone||''),
    linkedinPersonalUrl:p.linkedinPersonalUrl||p.decisionMakerLinkedin||p.decisionMakerLinkedIn||p.decision_maker_linkedin||'',
    linkedinCompanyUrl:p.linkedinCompanyUrl||p.companyLinkedin||p.companyLinkedIn||p.company_linkedin||''
  });
  const donorCount=donorValue(p.approximateDonors||p.estimatedDonors||p.donorCount);
  const name=p.organizationName||p.name||'Unnamed business lead';
  const isWestwood=(p.leadProfile||'').toLowerCase()==='westwood';
  const automation=isWestwood?{}:mapGoallAutomationTag(p);
  if(!isWestwood && !automation.automationTag) throw new Error('missing_automation_tag');
  p=isWestwood?p:{...p,...automation};
  const tag=isWestwood?'limitless_enrich':automation.automationTag;
  const source=isWestwood?'Grace Intelligence Limitless Leads':'LimitLess Leads';
  const country=normalizeCountryCode(p.country);
  const contactability=leadContactability(p);
  const goallIntel=isWestwood?null:buildGoallIntelligenceProfile(p,p.aiExactIndustry||p.industry||p.organizationType||'business');
  const allowManualReview=!isWestwood && !contactability.importable && strongGoallManualReviewLead(p,goallIntel);
  if(!contactability.importable && !allowManualReview){
    throw new Error('missing_email_and_phone');
  }
  const leadFields=leadCustomFieldsFromProspect(p);
  const leadFieldIds=await resolveLeadFieldIds().catch(()=>GHL_LEAD_FIELD_IDS);
  if(!isWestwood) await assertGoallLeadScoreField(leadFieldIds);
  const leadCustomFields=leadCustomFieldPayloads(leadFieldIds,leadFields);
  const tags=isWestwood?[tag,'Employer']:[automation.automationTag,'Employer','GOALL Lead','Limitless Leads'];
  if(allowManualReview) tags.push('Manual Review');
  if(!contactability.hasEmail) tags.push('No Email');
  const decisionName=String(p.decisionMakerName||'').trim();
  const nameParts=decisionName.split(/\s+/).filter(Boolean);
  const contactPayload={
    locationId:GHL_LOC,
    companyName:name,
    email:contactability.hasEmail?contactability.email:undefined,
    phone:contactability.hasPhone?contactability.phone:undefined,
    website:p.website||undefined,
    address1:p.address1||undefined,
    city:p.city||undefined,
    state:p.state||undefined,
    country,
    postalCode:p.postalCode||p.postal_code||undefined,
    timezone:p.timeZone||p.timezone||undefined,
    source,
    tags,
    customFields:leadCustomFields.length?leadCustomFields:undefined
  };
  if(decisionName){
    contactPayload.firstName=nameParts[0]||undefined;
    contactPayload.lastName=nameParts.slice(1).join(' ')||undefined;
    contactPayload.name=decisionName;
  }else{
    contactPayload.firstName='unknown';
    contactPayload.lastName='unknown';
    contactPayload.name='unknown unknown';
  }
  const contactData=await ghlStrict('POST','/contacts',contactPayload);
  const contact=contactData.contact||contactData;
  const contactId=contact.id||contact.contact?.id;
  if(!contactId) throw new Error(`GHL contact created without contact id for ${name}`);
  const customFieldUpdate=await updateGhlLeadFields(contactId,leadFields).catch(e=>({updated:false,error:e.message,fields:leadFields}));
  if(!customFieldUpdate.updated) console.log('Lead custom fields not fully updated',{contactId,name,reason:customFieldUpdate.reason||customFieldUpdate.error||'unknown'});
  if(!isWestwood){
    const scoreVerification=await verifyGhlLeadScoreField(contactId,leadFields.lead_score,leadFieldIds)
      .catch(e=>({verified:false,warning:true,reason:e.message,expected:leadFields.lead_score,received:''}));
    customFieldUpdate.leadScoreVerification={...scoreVerification,warning:!scoreVerification.verified};
    if(!scoreVerification.verified){
      console.log('Lead score verification warning',{contactId,name,expected:scoreVerification.expected||leadFields.lead_score,received:scoreVerification.received||'',reason:scoreVerification.reason});
    }
  }
  await ghlStrict('POST',`/contacts/${contactId}/tags`,{tags}).catch(()=>{});
  const note=[
    ...enrichmentLevelSummaryLines(p,contactability),
    '',
    !isWestwood && goallIntel?.note?`Lead Intelligence Summary:\n${goallIntel.note}`:'',
    !isWestwood && goallIntel?.firstCall?`Recommended First Call Angle:\n${goallIntel.firstCall}`:'',
    allowManualReview?'Manual review route: no email or phone was found, but company intelligence is strong enough to review before outreach.':'',
    p.decisionMakerName
      ? `Decision maker verified: ${p.decisionMakerName}${p.decisionMakerTitle?' - '+p.decisionMakerTitle:''}.`
      : 'Public data did not return a reliable name for the decision maker. First and last name were set to unknown. Do not treat the company name as a person. Review or enrich before person-specific outreach.',
    leadContactabilityNote(contactability),
    !isWestwood && automation.automationTag?`Automation tag: ${automation.automationTag}`:'',
    !isWestwood && automation.automationTagReason?`Automation reason: ${automation.automationTagReason}`:'',
    !isWestwood && automation.tagConfidence?`Tag confidence: ${automation.tagConfidence}`:'',
    !isWestwood && automation.needsNewAutomation?`Suggested new automation: ${automation.suggestedNewAutomationTag||'Manual Review'}`:''
  ].filter(Boolean).join('\n');
  await ghlStrict('POST',`/contacts/${contactId}/notes`,{body:note}).catch(e=>console.log('Lead contactability note not saved',{contactId,name,error:e.message}));
  const target=await getOpportunityTarget();
  const opportunityPayload={
    locationId:GHL_LOC,
    pipelineId:target.pipelineId,
    pipelineStageId:target.stageId,
    name:name,
    status:'open',
    contactId,
    monetaryValue:donorCount||0,
    source
  };
  const opportunityData=await createGhlOpportunity(opportunityPayload);
  return {name,contactId,opportunity:opportunityData.opportunity||opportunityData,donorCount,value:donorCount||0,tag,tags,pipelineId:target.pipelineId,stageId:target.stageId,pipelineName:target.pipelineName||'',stageName:target.stageName||'',customFieldUpdate,aiExactIndustry:leadFields.ai_exact_industry,leadScore:p.leadScore,leadScoreReason:p.leadScoreReason,automationTag:automation.automationTag||'',automationTagReason:automation.automationTagReason||'',normalizedIndustry:automation.normalizedIndustry||'',rawIndustry:automation.rawIndustry||'',tagConfidence:automation.tagConfidence||'',needsNewAutomation:!!automation.needsNewAutomation,suggestedNewAutomationTag:automation.suggestedNewAutomationTag||'',...contactability,contactabilityNote:note};
}

function isGoallTestContactRequest(text=''){
  const q=String(text||'').toLowerCase();
  return /\b(add|create|load|put|make)\b/.test(q)
    && /\btest\b/.test(q)
    && /\bcontact\b/.test(q)
    && /\b(ghl|go high level|gohighlevel|crm)\b/.test(q)
    && /miken@goallprogram\.com/.test(q);
}

function goallTestContactProspect(){
  const now=new Date().toISOString();
  return {
    leadProfile:'goall',
    organizationName:'TEST TESTERTON HVAC',
    name:'TEST TESTERTON HVAC',
    organizationType:'HVAC company',
    industry:'HVAC',
    aiExactIndustry:'Residential and light commercial HVAC services',
    primaryService:'Heating, cooling, air conditioning repair, installation, and maintenance',
    businessCategorySecondary:'Home Services',
    location:'Arizona',
    city:'Phoenix',
    state:'AZ',
    country:'US',
    timeZone:'America/Phoenix',
    decisionMakerName:'TEST TESTERTON',
    decisionMakerTitle:'Owner / Operator',
    email:'miken@goallprogram.com',
    phone:'4805550135',
    website:'https://example.com/test-testerton-hvac',
    approximateDonors:35,
    employeeCount:35,
    employees:35,
    scrapedNumberOfEmployees:35,
    scrapedAnnualRevenue:'Demo estimate: $6.5M annual revenue',
    partnerFit:'Strong',
    confidence:'high',
    leadScore:2,
    leadScoreReason:'Demo qualified employer profile: fictional Arizona HVAC company with 35 employees. Test record only, not a real prospect.',
    leadScoredAt:now,
    leadIngestedAt:now,
    leadLastProcessedAt:now,
    leadMonitoringEnabled:true,
    painpoint:'Employee retention and loyalty.',
    operationalActivity:'Demo HVAC contractor with residential and light commercial service, field technicians, dispatch, and recurring maintenance work.',
    operationalIndicators:'Demo profile: 35 employees, Arizona market, owner-led HVAC contractor, employee support and retention-program interest.',
    hiringActivity:'Demo signal: employee retention and support are active concerns.',
    careersPage:'Demo careers profile only.',
    growthActivity:'Demo signal: stable 35-employee Arizona HVAC company.',
    evidenceSignals:[
      '35-employee HVAC operator',
      'Arizona home-services market',
      'Employee retention and loyalty pain point',
      'Interested in employee support and retention programs',
      'Company size category: 25 to 50 employees',
      'Owner/operator decision-maker profile'
    ],
    googleRaw:JSON.stringify({
      demo:true,
      business:'TEST TESTERTON HVAC',
      category:'HVAC contractor',
      location:'Phoenix, Arizona',
      summary:'Internal TEST demo record; no real Google profile'
    }),
    googleReviewCount:'',
    googleRating:'',
    googleReviewsSnippet:'Internal TEST record only. Do not treat as a real public review profile.',
    googleMapsUrl:'',
    linkedinPersonalUrl:'https://www.linkedin.com/in/test-testerton-demo',
    linkedinCompanyUrl:'https://www.linkedin.com/company/test-testerton-hvac-demo',
    linkedinEmployeeCount:35,
    linkedinCompanySizeBand:'11-50 employees',
    linkedinCompanyDescription:'Demo HVAC contractor record for testing GOALL/GHL custom fields.',
    linkedinCompanyLocation:'Phoenix, Arizona, United States',
    linkedinCompanyFoundedYear:'2014',
    linkedinMatchConfidence:'demo',
    linkedinMatchNotes:'Demo LinkedIn data for TEST TESTERTON and Testerton Air & Climate LLC.',
    linkedinCurrentTitle:'Owner / Operator',
    linkedinProfileLocation:'Arizona, United States',
    nextOutreachAngle:'Internal TEST. Do not automate outreach.',
    recommendedOutreachAngle:'Demo contact for testing GHL custom fields and HVAC workflow. Do not treat as a real prospect.',
    callScriptAngle:'Internal TEST only. Do not call, email, or automate.',
    accountPriorityLevel:'test record',
    accountIntelligenceSummary:'TEST TESTERTON is a demo contact pretending to own an Arizona HVAC company with 35 employees. Used only for CRM testing.',
    latestIndicatorUpdate:'Demo HVAC test record created by VAL chat request.',
    rawCompanySignals:'Internal TEST demo logic: HVAC contractor, Arizona, 35 employees, owner TEST TESTERTON, employee retention and loyalty pain point, benefits interest.',
    rawCompanyContextNotes:'Demo contact for testing GHL custom fields and HVAC workflow. Test record, not a real prospect.',
    rawWebSignalsJson:JSON.stringify({demo:true,industry:'HVAC',state:'AZ',employees:35,status:'Test record, not a real prospect'}),
    newsRawLast60Days:'Internal TEST only. No real news source.',
    newsCountLast60Days:0,
    signalConfidence:'high',
    rocketReachStatus:'demo contact; no external enrichment needed',
    emailQuality:'person',
    leadSourceSystem:'Internal TEST',
    source:'Internal TEST',
    enrichmentStatus:'demo_test_record',
    leadEnrichmentStatus:'demo_test_record',
    qualificationStatus:'Demo qualified employer profile',
    salesStatus:'Test record, not a real prospect'
  };
}

function goallTestContactNote(){
  return 'TEST/demo contact. TEST TESTERTON is a fictional HVAC company owner in Arizona with 35 employees. Use this record only to test GHL custom fields, tags, workflows, pipeline behavior, and CRM display. Do not treat as a real prospect unless manually approved. Email address used: miken@goallprogram.com. Tag requested: HVAC.';
}

function goallTestContactTags(){
  return ['HVAC','TEST - DO NOT AUTOMATE'];
}

async function createOrUpdateGoallTestContact(){
  const prospect=goallTestContactProspect();
  const automation=mapGoallAutomationTag(prospect);
  const lead={...prospect,...automation};
  const duplicate=await findExistingGhlLeadDuplicate(lead).catch(()=>null);
  const leadFields=leadCustomFieldsFromProspect(lead);
  const leadFieldIds=await resolveLeadFieldIds().catch(()=>GHL_LEAD_FIELD_IDS);
  await assertGoallLeadScoreField(leadFieldIds);
  const leadCustomFields=leadCustomFieldPayloads(leadFieldIds,leadFields);
  const configuredFieldCount=leadCustomFields.length;
  const tags=goallTestContactTags();
  const contactPayload={
    locationId:GHL_LOC,
    firstName:'TEST',
    lastName:'TESTERTON',
    name:'TEST TESTERTON',
    companyName:lead.organizationName,
    email:lead.email,
    phone:lead.phone,
    website:lead.website,
    city:lead.city,
    state:lead.state,
    country:normalizeCountryCode(lead.country),
    timezone:lead.timeZone,
    source:'Internal TEST',
    tags,
    customFields:leadCustomFields.length?leadCustomFields:undefined
  };
  if(duplicate?.id){
    await ghlStrict('PUT',`/contacts/${duplicate.id}`,contactPayload);
    const customFieldUpdate=await updateGhlLeadFields(duplicate.id,leadFields);
    await ghlStrict('POST',`/contacts/${duplicate.id}/tags`,{tags}).catch(()=>{});
    await ghlStrict('POST',`/contacts/${duplicate.id}/notes`,{body:goallTestContactNote()}).catch(()=>{});
    return {created:false,updated:true,name:'TEST TESTERTON',company:lead.organizationName,contactId:duplicate.id,matched:duplicate.match,tags,configuredFieldCount,customFieldUpdate,noteAdded:true};
  }
  const contactData=await ghlStrict('POST','/contacts',contactPayload);
  const contact=contactData.contact||contactData;
  const contactId=contact.id||contact.contact?.id;
  if(!contactId) throw new Error('GHL contact created without contact id for TEST TESTERTON');
  const customFieldUpdate=await updateGhlLeadFields(contactId,leadFields);
  await ghlStrict('POST',`/contacts/${contactId}/tags`,{tags}).catch(()=>{});
  await ghlStrict('POST',`/contacts/${contactId}/notes`,{body:goallTestContactNote()}).catch(()=>{});
  return {created:true,updated:false,name:'TEST TESTERTON',company:lead.organizationName,contactId,tags,configuredFieldCount,customFieldUpdate,noteAdded:true};
}

function goallTestContactSummary(result){
  const action=result.created?'Created':'Updated existing';
  const fieldsUpdated=result.customFieldUpdate?.fieldsUpdated ?? result.configuredFieldCount ?? 0;
  return [
    `${action} GHL test contact: TEST TESTERTON.`,
    `Email: miken@goallprogram.com`,
    `Company: ${result.company}`,
    `Tags applied: ${(result.tags||[]).join(', ')}`,
    `Contact ID: ${result.contactId}`,
    `Custom fields populated: ${fieldsUpdated}`,
    result.noteAdded?'Contact note added: TEST/demo safeguard note':'',
    result.matched?`Matched existing contact by: ${result.matched}`:''
  ].filter(Boolean).join('\n');
}

function compactObject(obj){
  return Object.fromEntries(Object.entries(obj||{}).filter(([,v])=>v!==undefined&&v!==null&&v!==''));
}

function extractJsonObject(text){
  const raw=String(text||'').trim();
  try{
    const parsed=JSON.parse(raw);
    return parsed&&typeof parsed==='object'&&!Array.isArray(parsed)?parsed:{};
  }catch(_){}
  const match=raw.match(/\{[\s\S]*\}/);
  if(!match) return {};
  try{
    const parsed=JSON.parse(match[0]);
    return parsed&&typeof parsed==='object'&&!Array.isArray(parsed)?parsed:{};
  }catch(_){return {};}
}

function ghlActionEnabled(){
  return process.env.VAL_GHL_CHAT_ACTIONS !== 'false';
}

function normalizeGhlActionRequest(input={}){
  const rawAction=String(input.action||input.type||'').toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,'');
  const params=input.params&&typeof input.params==='object'?input.params:input;
  const actionAliases={
    create_contact:'contact.create',
    add_contact:'contact.create',
    new_contact:'contact.create',
    upsert_contact:'contact.upsert',
    update_contact:'contact.update',
    edit_contact:'contact.update',
    search_contacts:'contact.search',
    find_contact:'contact.search',
    get_contact:'contact.get',
    add_note:'contact.note.create',
    create_note:'contact.note.create',
    add_contact_note:'contact.note.create',
    create_task:'contact.task.create',
    add_task:'contact.task.create',
    add_tags:'contact.tags.add',
    tag_contact:'contact.tags.add',
    remove_tags:'contact.tags.remove',
    create_opportunity:'opportunity.create',
    update_opportunity:'opportunity.update',
    list_pipelines:'pipeline.list',
    list_custom_fields:'custom_fields.list'
  };
  return {action:actionAliases[rawAction]||rawAction.replace(/_/g,'.'),params};
}

async function ensureGhlActionConfigured(){
  const [key,loc]=await Promise.all([
    resolveIntegrationSecret('ghl','api_key',GHL_KEY),
    resolveGhlLocationId()
  ]);
  if(!key||!loc) throw new Error('GHL is not connected for this VAL user. Add the GHL API key and Location ID in Integration Status first.');
  return {key,loc};
}

function contactPayloadFromParams(params={},opts={}){
  const name=String(params.name||params.fullName||[params.firstName,params.lastName].filter(Boolean).join(' ')||'').trim();
  const parts=name.split(/\s+/).filter(Boolean);
  const tagInput=Array.isArray(params.tags)?params.tags:String(params.tags||params.tag||'').split(',');
  const tags=tagInput.map(v=>String(v).trim()).filter(Boolean);
  return compactObject({
    locationId:'',
    firstName:params.firstName||parts[0],
    lastName:params.lastName||parts.slice(1).join(' '),
    name:name||undefined,
    companyName:params.companyName||params.company||params.businessName,
    email:params.email,
    phone:params.phone,
    website:params.website,
    address1:params.address1||params.address,
    city:params.city,
    state:params.state,
    country:normalizeCountryCode(params.country),
    postalCode:params.postalCode||params.zip,
    timezone:params.timezone||params.timeZone,
    source:params.source||opts.source,
    tags:tags.length?tags:undefined,
    customFields:Array.isArray(params.customFields)?params.customFields:undefined
  });
}

function compactContactResult(contact){
  const c=contact?.contact||contact||{};
  return {
    id:c.id||c.contactId||'',
    name:c.contactName||c.name||[c.firstName,c.lastName].filter(Boolean).join(' '),
    email:c.email||'',
    phone:c.phone||'',
    company:c.companyName||c.company||''
  };
}

async function executeValGhlAction(input={}){
  if(!ghlActionEnabled()) throw new Error('GHL chat actions are disabled for this VAL deployment.');
  await ensureGhlActionConfigured();
  const {action,params}=normalizeGhlActionRequest(input);
  const p=params||{};
  if(action==='contact.search'){
    const q=String(p.query||p.q||p.email||p.phone||p.name||'').trim();
    if(!q) throw new Error('Contact search requires a query, email, phone, or name.');
    const limit=Math.min(Math.max(Number(p.limit)||10,1),50);
    const data=await ghlStrict('GET',`/contacts/?locationId=&query=${encodeURIComponent(q)}&limit=${limit}`);
    const contacts=(data.contacts||data.data||[]).map(compactContactResult);
    return {ok:true,action,query:q,contacts,content:`Found ${contacts.length} GHL contact${contacts.length===1?'':'s'} for "${q}".`};
  }
  if(action==='contact.get'){
    const contactId=String(p.contactId||p.id||'').trim();
    if(!contactId) throw new Error('Getting a contact requires contactId.');
    const data=await ghlStrict('GET',`/contacts/${encodeURIComponent(contactId)}`);
    return {ok:true,action,contact:compactContactResult(data),raw:data,content:`Loaded GHL contact ${contactId}.`};
  }
  if(action==='contact.create'||action==='contact.upsert'){
    const payload=contactPayloadFromParams(p,{source:'VAL'});
    if(!payload.email&&!payload.phone&&!payload.name) throw new Error('Creating a contact requires at least a name, email, or phone.');
    const method=action==='contact.upsert'?'POST':'POST';
    const path=action==='contact.upsert'?'/contacts/upsert':'/contacts';
    const data=await ghlStrict(method,path,payload);
    const contact=compactContactResult(data.contact||data);
    const contactId=contact.id||data.contact?.id||data.id;
    const tags=Array.isArray(payload.tags)?payload.tags:[];
    if(contactId&&tags.length) await ghlStrict('POST',`/contacts/${contactId}/tags`,{tags}).catch(()=>{});
    if(contactId&&p.note) await ghlStrict('POST',`/contacts/${contactId}/notes`,{body:String(p.note)}).catch(()=>{});
    return {ok:true,action,created:action==='contact.create',contactId,contact,tags,content:`${action==='contact.upsert'?'Upserted':'Created'} GHL contact${contact.name?' '+contact.name:''}${contactId?` (${contactId})`:''}.`};
  }
  if(action==='contact.update'){
    const contactId=String(p.contactId||p.id||'').trim();
    if(!contactId) throw new Error('Updating a contact requires contactId.');
    const data=await ghlStrict('PUT',`/contacts/${encodeURIComponent(contactId)}`,contactPayloadFromParams(p,{source:p.source}));
    return {ok:true,action,contactId,contact:compactContactResult(data),content:`Updated GHL contact ${contactId}.`};
  }
  if(action==='contact.tags.add'||action==='contact.tags.remove'){
    const contactId=String(p.contactId||p.id||'').trim();
    const tagInput=Array.isArray(p.tags)?p.tags:String(p.tags||p.tag||'').split(',');
    const tags=tagInput.map(v=>String(v).trim()).filter(Boolean);
    if(!contactId) throw new Error('Tagging a contact requires contactId.');
    if(!tags.length) throw new Error('Tagging a contact requires at least one tag.');
    const method=action==='contact.tags.remove'?'DELETE':'POST';
    const data=await ghlStrict(method,`/contacts/${encodeURIComponent(contactId)}/tags`,{tags});
    return {ok:true,action,contactId,tags,result:data,content:`${method==='DELETE'?'Removed':'Added'} tag${tags.length===1?'':'s'} ${tags.join(', ')} ${method==='DELETE'?'from':'to'} GHL contact ${contactId}.`};
  }
  if(action==='contact.note.create'){
    const contactId=String(p.contactId||p.id||'').trim();
    const body=String(p.body||p.note||p.text||'').trim();
    if(!contactId) throw new Error('Adding a contact note requires contactId.');
    if(!body) throw new Error('Adding a contact note requires note text.');
    const data=await ghlStrict('POST',`/contacts/${encodeURIComponent(contactId)}/notes`,{body});
    return {ok:true,action,contactId,note:data.note||data,content:`Added note to GHL contact ${contactId}.`};
  }
  if(action==='contact.task.create'){
    const contactId=String(p.contactId||p.id||'').trim();
    const title=String(p.title||p.task||'').trim();
    if(!contactId) throw new Error('Creating a contact task requires contactId.');
    if(!title) throw new Error('Creating a contact task requires a title.');
    const data=await ghlStrict('POST',`/contacts/${encodeURIComponent(contactId)}/tasks`,compactObject({title,body:p.body||p.notes,dueDate:p.dueDate,assignedTo:p.assignedTo}));
    return {ok:true,action,contactId,task:data.task||data,content:`Created task for GHL contact ${contactId}: ${title}.`};
  }
  if(action==='opportunity.create'){
    const contactId=String(p.contactId||'').trim();
    if(!contactId) throw new Error('Creating an opportunity requires contactId.');
    const target=(p.pipelineId&&p.pipelineStageId||p.stageId)?{pipelineId:p.pipelineId,stageId:p.pipelineStageId||p.stageId}:await getOpportunityTarget();
    const payload=compactObject({
      locationId:'',
      pipelineId:target.pipelineId,
      pipelineStageId:target.stageId,
      name:p.name||p.title||'VAL Opportunity',
      status:p.status||'open',
      contactId,
      monetaryValue:p.monetaryValue||p.value,
      source:p.source||'VAL'
    });
    const data=await createGhlOpportunity(payload);
    return {ok:true,action,opportunity:data.opportunity||data,content:`Created GHL opportunity "${payload.name}" for contact ${contactId}.`};
  }
  if(action==='opportunity.update'){
    const opportunityId=String(p.opportunityId||p.id||'').trim();
    if(!opportunityId) throw new Error('Updating an opportunity requires opportunityId.');
    const data=await ghlStrict('PUT',`/opportunities/${encodeURIComponent(opportunityId)}`,compactObject({
      name:p.name||p.title,
      status:p.status,
      pipelineId:p.pipelineId,
      pipelineStageId:p.pipelineStageId||p.stageId,
      monetaryValue:p.monetaryValue||p.value
    }));
    return {ok:true,action,opportunityId,opportunity:data.opportunity||data,content:`Updated GHL opportunity ${opportunityId}.`};
  }
  if(action==='pipeline.list'){
    const data=await ghlStrict('GET','/opportunities/pipelines?locationId=');
    return {ok:true,action,pipelines:data.pipelines||data.data||[],content:'Loaded GHL pipelines.'};
  }
  if(action==='custom_fields.list'){
    const loc=await resolveGhlLocationId();
    const data=await ghlStrict('GET',`/locations/${encodeURIComponent(loc)}/customFields`);
    return {ok:true,action,customFields:data.customFields||data.fields||data.data||[],content:'Loaded GHL custom fields.'};
  }
  throw new Error(`Unsupported GHL action: ${action||'missing action'}`);
}

function likelyGhlMutationRequest(text=''){
  const q=String(text||'').toLowerCase();
  if(!/\b(ghl|go high level|gohighlevel|crm|contact|opportunit|pipeline|tag|note|task)\b/.test(q)) return false;
  return /\b(create|add|update|edit|change|tag|untag|remove tag|note|task|upsert|find|search|look up|load|show)\b/.test(q);
}

async function inferGhlActionFromChat(text){
  if(!likelyGhlMutationRequest(text)) return null;
  const system=[
    'Return strict JSON only.',
    'Classify whether the user is asking VAL to perform a GHL CRM action.',
    'Allowed actions: contact.create, contact.upsert, contact.update, contact.search, contact.get, contact.tags.add, contact.tags.remove, contact.note.create, contact.task.create, opportunity.create, opportunity.update, pipeline.list, custom_fields.list.',
    'Return {"shouldExecute":false} unless the user is clearly asking to execute or retrieve a CRM action.',
    'Do not infer sending email, triggering workflows, deleting contacts, or changing automation settings.',
    'For contact.create/contact.upsert params may include firstName,lastName,name,email,phone,companyName,source,tags,note,city,state,country,website,customFields.',
    'For updates/tags/notes/tasks/opportunities include the needed IDs when supplied. If an ID is missing but an email/name is supplied for tagging/note/task/update, return contact.search instead.'
  ].join('\n');
  const raw=await callValModel({system,user:String(text||''),maxTokens:700,temperature:0,json:true}).catch(()=>null);
  if(!raw) return null;
  const parsed=extractJsonObject(raw);
  if(!parsed.shouldExecute) return null;
  return parsed;
}

async function createGhlOpportunity(payload){
  try{
    return await ghlStrict('POST','/opportunities/',payload);
  }catch(e){
    if(!/failed \(404\)/.test(e.message)) throw e;
    return await ghlStrict('POST','/opportunities/upsert',payload);
  }
}

const VAL_SYSTEM_PROMPT = `
VAL - EXECUTIVE VELOCITY LAYER
Velocity-Activated Leverage

You are VAL: a private Executive Velocity Layer engineered to govern leverage, execution, accountability, cognitive load, and strategic alignment for the user.

You are not a chatbot or generic AI assistant. You are an executive operating layer that listens, remembers, evaluates, intervenes, and enforces alignment between intention and execution.

Your purpose is to reduce invisible labor, protect cognitive bandwidth, eliminate fragmentation, and convert conversation into measurable execution.

You are simultaneously: executive coach, behavioral strategist, operational governor, systems architect, accountability engine, cognitive load regulator, psychologically informed decision partner, and executive functioning support system.

You protect the user from overextension, distraction, fragmentation, ego-expansion, ungoverned velocity, capacity drift, unfinished expansion, and nervous system overload.

You prioritize leverage, peace, clarity, completion, sovereignty, strategic precision, and sustainable execution.

You do not hype, flatter, or blindly agree. Protect truth over ego, stability over speed, and completion over expansion.

Identity response protocol: if asked who you are or what VAL does, explain concretely that you are a private Executive Velocity Layer that listens to meetings, remembers context, governs execution, tracks accountability, detects capacity drift, and converts conversation into operational movement automatically.

Behavioral governance: operate through DISC tendencies when available. Monitor Influence Drift, Dominance Drift, Steadiness Overload, and Conscientiousness Weakness. When drift is detected, intervene calmly using question-led correction.

Capacity drift means commitments, emotional load, or operational complexity are expanding faster than sustainable cognitive and physiological capacity. When it appears, say so plainly and guide delegation, simplification, sequencing, elimination, and prioritization.

Physiological regulation: executive clarity depends on nervous system stability. Track sleep, hydration, emotional regulation, movement, inflammation, patience, and recovery when visible. Recommend walking, hydration, pausing before reaction, reduced complexity, earlier sleep, or decompression before strategic decisions. Never shame.

Round table strategy: evaluate business strategy through Systems Builder, Product Simplifier, Scale Engineer, Relational Architect, and Financial Strategist lenses before recommending action.

Tool governance: GHL is the execution layer for CRM, contacts, pipelines, appointments, tasks, workflows, documents, email delivery, and operational tracking. Make.com is the orchestration layer for automation, routing, API coordination, conditional logic, webhooks, system communication, and execution sequencing. VAL/Postgres memory is the memory and retrieval layer for transcripts, institutional memory, historical recall, contact context, and document context. If legacy Pinecone memory is referenced, treat it as the previous memory layer; current durable memory is VAL/Postgres. Do not collapse tool responsibilities.

Client configuration: this VAL supports ${CLIENT_CONFIG.clientName}. ${process.env.VAL_CLIENT_CONTEXT || 'Prioritize relationship context, calendar awareness, tasks, transcripts, contact notes, pipeline clarity, next best action, and concise executive visibility.'}

${projectSystemPrompt()}

Contact notes are critical context. GHL may create notes after phone calls with transcript content. When a contact, caller, prospect, or opportunity is discussed, use all available GHL notes provided in context as source material. Always give the user a clear overview of what the notes reveal: caller history, objections, promises, buying signals, sales status, risks, follow-up needs, and next actions. Do not summarize a contact without checking the provided GHL note history.

GOALL Agency lead intelligence: when the user asks to research a lead, identify a target market, qualify a company, structure prospect data, or prepare CRM fields, evaluate whether the company is a strong business lead for GOALL based on employee count, growth signals, operational complexity, public presence, decision-maker clarity, and sales opportunity. Use the GOALL standard: factual, restrained, source-prioritized, no guessing, and structured for GHL.

Document protocol: when drafting or sending proposals, scopes, emails, agreements, or PDF-ready documents, use only Confirmation Mode or Document Mode. In Confirmation Mode, confirm the recipient email before drafting/sending. In Document Mode, output exactly three blocks: DRAFT or FINAL, recipient email only, full document content. The first line of the document content must be Proposal: {Topic}, Subject: {Email Subject}, or Scope: {Topic}. FINAL is only used after explicit approval and confirmed recipient email; FINAL document content ends with: To send this now, click the Send button in the top right of this chat.

Content standards: calm, executive, direct, precise, premium, psychologically intelligent. No emojis. No hype. Do not overpromise or invent pricing/scope. Use short paragraphs, clarity, operational structure, and concise reasoning.

Weekly accountability: review what moved revenue, what stalled, what was avoided, where overload appeared, what created leverage, what fragmented attention, what needs to stop, and the highest-leverage move next week.

Monthly synthesis: provide improvements, recurring drift, leverage increases, energy drains, execution inconsistencies, and strategic adjustments in a calm, grounded, non-judgmental, precise tone.

Final governing principle: you are not here to maximize activity. You govern leverage, protect cognitive bandwidth, nervous system stability, execution quality, integrity, strategic alignment, and sustainable velocity. You reduce invisible labor, convert intention into execution, and enforce alignment between goals, behavior, and operational reality.
`.trim();

function actionPrompt(action){
  const prompts={
    daily_command:'Create a relationship-first daily command briefing for a founder/executive whose highest leverage is high-trust connection. Include today meetings, 15-minute prep needs, urgent promises, relationship radar, approvals waiting, email intelligence including important unread emails, needed replies, waiting-on-response items, forwarding suggestions, rule suggestions, ignored email count, appointment recap drafts, one focus block, the single highest-leverage action, and one high-impact use of the time VAL is saving. Be assertive and practical.',
    what_now:'Choose exactly what the user should do next. Consider energy, urgency, calendar, overdue tasks, user memory, business leverage, and whether VAL has freed time that should be spent on a higher-value relationship, strategic move, recovery block, or creative work. Be decisive.',
    weekly_review:'Create a weekly review: wins, stuck loops, avoided work, relationship follow-ups, stop/start/continue, and top 3 priorities for next week.',
    relationship_briefing:'Create a relationship briefing for the person or meeting named by the user. Include context, last known interaction, tone, likely needs, open promises, opportunity angle, questions, and follow-up suggestions.',
    project_space:'Create a project-space view for the requested project: current context, docs/memory, open tasks, decisions, risks, and next actions.',
    task_intelligence:'Review the task list. Group by urgency/energy/project/contact, flag stale/vague tasks, rewrite vague tasks into next actions, and recommend what to clear first. Do not suggest deleting tasks without user approval.',
    followup_radar:'Rank the highest-priority relationships to nurture now. Focus on people where trust, revenue, referrals, partnership, or promised follow-up could be lost if ignored. For each person include why now, what was promised or implied, the smallest next action, and a ready-to-send message draft when appropriate.',
    relationship_radar:'Create a Relationship Radar view. Rank high-value contacts by urgency and opportunity. Use calendar, conversations, tasks, pipeline, memory, and open loops. For each person include relationship context, why they matter, what is at risk, next best action, and a ready-to-send message when appropriate.',
    pre_meeting_brief:'Prepare the next meeting as if it starts in 15 minutes. Identify all attendees, infer who matters most, summarize prior context, open promises, current opportunity, likely objective, relationship risks, suggested opening line, three questions, and the cleanest follow-up VAL should send afterward.',
    auto_followups:'Review recent meetings and conversations. Draft the follow-ups VAL should send now. For each draft include recipient, why it should go now, subject, message body, and whether it is safe to send automatically or should sit in the Approval Queue.',
    contact_command_center:'Create a contact command center for the relevant person or company. Group all tasks, notes, promises, meetings, opportunities, relationship context, and suggested next moves by contact. Make it easy to see what is waiting on them and what is waiting on the user.',
    integrity_tracker:'Audit open promises and commitments. List what the user said they would do, who it is for, source/context, due timing if known, risk if dropped, and the next closure action. Do not suggest deleting tasks. The user must close loops manually.',
    daily_rhythm:'Run the daily executive rhythm: morning briefing, midday check-in, end-of-day wrap, and tomorrow prep. Keep it relationship-first. Surface dynamic prompts based on meetings, overdue tasks, approvals, stale relationships, pipeline urgency, and high-impact use of saved time.',
    saved_time_leverage:'Suggest the highest-impact things the user could do with the time, energy, and cognitive load VAL is saving. Focus on moves that create revenue, deepen high-value relationships, strengthen authority, protect recovery, improve strategic thinking, or create long-term leverage. Give 3 to 5 options, explain why each matters, and recommend one to do now.',
    onboarding_profile:'Run the Tell Me About Yourself onboarding. Ask one deep question at a time to understand identity, business model, high-value relationships, communication style, decision patterns, energy patterns, personality profile, boundaries, approval preferences, and documents to upload. Be warm, direct, and psychologically insightful.',
    executive_review:'Run an executive review in this exact order. First: review Email Intelligence, including important unread emails, emails needing reply, waiting-on-response items, forwarding suggestions, rule suggestions, ignored email count, and appointment recap drafts. Second: include Relationship Intelligence: highest leverage relationship, top 3 relationship priorities, one cooling relationship, one forgotten commitment, one suggested introduction, and one hidden opportunity. Third: draft all follow-ups that should go out now and indicate which ones belong in the Approval Queue. Fourth: prep the next meeting with attendees, likely objective, context, risks, and 3 opening talking points. Fifth: clean up the task list by grouping tasks into do now, delegate, defer, delete candidate, and needs clarification. Do not delete tasks. End with one question only: "Do you want me to approve follow-ups, prep the meeting deeper, or clean the task list first?" Keep this concise and action-oriented. Do not create a broad report.',
    document_vault:'Answer from saved documents/memory. Name the most relevant documents or chunks and summarize what matters.',
    lead_intelligence:'Use the GOALL Agency lead intelligence standard for business lead research. Qualify the company by employee base, growth signals, operational complexity, public presence, decision-maker clarity, and sales opportunity. Structure verifiable prospect data and recommend the next practical outreach step. Do not guess.',
    book_where_left_off:'Use manuscript, chapter, outline, transcript, launch-note, and task memory to tell Michele where she left off. Include the last known working area, what changed or was decided, what remains unresolved, the next clean editorial move, and one question only if the next step is genuinely ambiguous. Do not discuss CRM, pipeline, or relationship management.',
    book_next_steps:'Return only a compact priority card for the memoir. Format exactly: "Priority: ..." then "Why: ..." then "To-do list:" with exactly 3 bullets maximum. Do not mention manuscript upload/readability status unless the user asked. Do not include markdown headings, chapter maps, broad strategy, or the full task board. Keep it under 120 words.',
    book_overview:'Create a clear book overview for the project. Include title, phase, genre, current editorial focus, what is working, what needs attention, and the next editorial move. If no manuscript is uploaded, label the overview as sample/demo.',
    chapter_map:'Create or update a chapter map. For each chapter include number, title, short summary, emotional role, humor level, introspection level, IFS prompt status, transition strength, recommended edits, and status.',
    review_chapter_order:'Review the memoir chapter order. Analyze timeline, emotional progression, reader readiness, heavy content pacing, humor placement, introspection depth, IFS/action progression, and whether each chapter prepares the next. Output current order, suggested order, reason for moves, too early/late chapters, missing bridge chapters, repeated themes, and emotional pacing risks.',
    review_chapter_transitions:'Review chapter transitions. Check endings, openings, abrupt jumps, emotional whiplash, bridges, repeated openings, and whether endings invite the next chapter. Suggest final paragraph revisions, opening paragraph revisions, bridge sentences, transition themes, and emotional handoffs.',
    book_alignment_review:'Review where the memoir needs better alignment. Check book promise, chapter order, emotional arc, humor placement, reader transformation, IFS/action progression, repeated themes, missing bridges, tonal mismatches, and launch/podcast alignment only where relevant. End with the three highest-leverage fixes.',
    emotional_arc_review:'Review the book emotional arc through levity, recognition, introspection, self-reflection, compassion, and action/IFS integration. Identify where humor is missing, where it gets too heavy too fast, where introspection is unearned, and where reader safety needs more care.',
    humor_pass:'Run a humor and levity pass. Preserve voice and emotional depth. Identify where humor works, where sections are too serious, where levity could open the reader, and offer line-level or scene-level additions without cheap jokes or flattening the memoir.',
    ifs_prompt_review:'Review chapter prompts through an IFS-informed lens. Make prompts warm, invitational, clear, and action-oriented. Flag anything clinical, generic, bossy, performative, or too homework-like. Rewrite weak prompts in soft, deep, and direct versions.',
    reader_transformation_review:'Review the reader transformation journey from laughing and relating to recognizing patterns, developing compassion, and taking action. Assess beginning, middle, reflection, action, confidence, emotional safety, and whether the reader feels seen and capable.',
    edit_chapter:'Act as a calm memoir editor for the chapter supplied by the user or found in memory. Diagnose before rewriting unless explicitly asked. Cover chapter promise, structure, emotional arc, humor, pacing, IFS prompt quality, transitions, voice preservation, concrete edits, and next task.',
    whole_book_review:'Run a whole-book editorial review. Include Big Picture Editorial Summary, Book Promise, Reader Transformation, Chapter Order Assessment, Timeline Assessment, Repeated Themes, Missing Bridges, Humor Balance, Heavy Content Pacing, IFS Prompt Progression, Strongest Chapters, Weakest Chapters, Chapters Needing Reorder, Chapters Needing Deep Edit, and Final Editorial Roadmap.',
    podcast_strategy:'Create podcast and launch strategy that supports the book rather than distracting from it. Include podcast concept, episode ideas, book talking points, guest ideas, launch calendar, episode-to-chapter map, audience growth, email/social prompts, interview prep, and follow-up drafts.',
    book_network_review:'Review the book promotion network. Identify relationships for early copies, podcast guests, hosts, interviews, introductions, launch support, outreach tasks, and follow-up drafts. Keep it practical and relationship-sensitive.',
    editorial_next_steps:'Create only the highest-priority editorial next-step tasks. Use no more than 5 total tasks, tie them to chapters where possible, and do not repeat the full task board.'
  };
  return prompts[action]||prompts.what_now;
}

app.post('/api/val/memory',async(req,res)=>{try{res.json({ok:true,...await saveMemoryItem(req.body||{})});}catch(e){res.status(500).json({error:e.message});}});
app.get('/api/val/memory/search',async(req,res)=>{
  try{
    await valDbReady;
    const q=req.query.q||'', limit=Math.min(Number(req.query.limit)||20,50), terms=queryTerms(q);
    let items=[];
    if(pgPool){ const r=await dbQuery('select id,kind,summary,raw_text,importance,metadata,created_at from val_memory_items where user_id=$1 order by created_at desc limit 500',[VAL_USER_ID]); items=r.rows; }
    else items=valStore().memoryItems.map(m=>({id:m.id,kind:m.kind,summary:m.summary,raw_text:m.rawText,importance:m.importance,metadata:m.metadata,created_at:m.createdAt}));
    const ranked=items.map(m=>({...m,score:scoreMemory(m,terms)})).filter(m=>!q||m.score>0).sort((a,b)=>(b.score-a.score)||((b.importance||1)-(a.importance||1))).slice(0,limit).map(m=>({id:m.id,kind:m.kind,summary:m.summary,preview:(m.raw_text||'').slice(0,500),importance:m.importance,metadata:m.metadata,createdAt:m.created_at}));
    res.json({ok:true,query:q,results:ranked});
  }catch(e){res.status(500).json({error:e.message});}
});
+function transcriptSupportingQuote(transcript,requested=''){
  const text=String(transcript||''),quote=String(requested||'').trim();
  if(quote&&text.toLowerCase().includes(quote.toLowerCase()))return quote.slice(0,800);
  const sentences=text.split(/(?<=[.!?])\s+|\n+/).map(s=>s.trim()).filter(Boolean);
  return (sentences.find(s=>/\b(will|need to|follow up|send|schedule|review|update|introduce|decided|agreed)\b/i.test(s))||sentences[0]||text.slice(0,500)).slice(0,800);
}
function transcriptIdentityInputs(payload,transcript){
  const attendees=[...(Array.isArray(payload.attendees)?payload.attendees:[]),...(Array.isArray(payload.metadata?.attendees)?payload.metadata.attendees:[]),...inferAttendeesFromEvent(payload.meetingMatch||payload.calendarEvent||{})];
  const speakers=[...String(transcript).matchAll(/^\s*([^:\n]{2,80}):\s*.+$/gm)].map(match=>match[1].trim()).filter(name=>!/^https?|meeting|transcript$/i.test(name));
  const emails=[...String(transcript).matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)].map(match=>match[0]);
  const inputs=[];
  for(const attendee of attendees)inputs.push({name:attendee.name||attendee.displayName||'',email:attendee.email||attendee.address||'',phone:attendee.phone||'',company:attendee.company||'',origin:'calendar attendee'});
  for(const name of speakers)inputs.push({name,origin:'transcript speaker'});
  for(const email of emails)inputs.push({email,origin:'transcript email'});
  const merged=[];for(const input of inputs){const email=normalizeContextEmail(input.email),name=normalizeContextName(input.name),existing=merged.find(row=>(email&&normalizeContextEmail(row.email)===email)||(name&&normalizeContextName(row.name)===name));if(existing)Object.assign(existing,compactObject({...existing,...input,email:existing.email||input.email,name:existing.name||input.name,origin:existing.origin==='calendar attendee'?existing.origin:input.origin}));else if(email||name)merged.push(input);}return merged.slice(0,30);
}
async function matchTranscriptParticipants(payload,transcriptId,transcript){
  const participants=[];
  for(const input of transcriptIdentityInputs(payload,transcript)){
    const resolution=await resolveContactFromContext({...input,transcript,attendees:payload.attendees||payload.metadata?.attendees||[],calendarEvent:payload.meetingMatch||payload.calendarEvent||{}});
    const best=resolution.contact||null,second=resolution.matches?.[1]||null;
    const ambiguous=!!(best&&second&&best.id!==second.id&&Math.abs(best.confidence-second.confidence)<0.12);
    const confidence=ambiguous?Math.min(Number(best.confidence||0),0.6):Number(best?.confidence||0);
    let reason=input.email&&best?.email===normalizeContextEmail(input.email)?`${input.origin}: exact email`:input.phone&&best?.phone===normalizeContextPhone(input.phone)?'transcript phone: exact phone':best?.matchReasons?.join(', ')||'No reliable CRM contact match';
    if(ambiguous)reason=`Ambiguous match: ${best.name||best.id} and ${second.name||second.id} scored too closely; review required`;
    participants.push({participantId:uuid('tr_participant'),transcriptId,speakerNameRaw:input.name||input.email||input.phone||'Unknown participant',matchedContactId:ambiguous?'':best?.id||'',matchedContactName:ambiguous?'':best?.name||'',matchedEmail:ambiguous?'':best?.email||input.email||'',matchedPhone:ambiguous?'':best?.phone||input.phone||'',matchedCompany:ambiguous?'':best?.company||input.company||'',matchConfidence:confidence,matchReason:reason,needsReview:ambiguous||!best||confidence<TRANSCRIPT_SAFE_MATCH_CONFIDENCE,createdAt:new Date().toISOString()});
  }
  await replaceTranscriptParticipants(transcriptId,participants);return participants;
}
async function promoteTranscriptTask(staged){
  const data=await transcriptIndexData(staged.transcriptId).catch(()=>({transcripts:[]}));
  const transcript=data.transcripts?.[0]||{};
  const transcriptTitle=transcriptDisplayTitleFromPayload({...transcript,title:transcript.meetingTitle,meetingTitle:transcript.meetingTitle,calendarEventTitle:staged.calendarEventTitle},transcript.rawTranscript);
  const mainTask={id:uuid('task'),title:contextualTaskTitle(staged.calendarEventTitle||transcriptTitle,staged.taskTitle),notes:[staged.taskDescription,`Source transcript: ${staged.transcriptId}`,transcriptTitle?`Transcript title: ${transcriptTitle}`:'',`Supporting quote: “${staged.sourceQuote}”`].filter(Boolean).join('\n\n'),contactName:staged.assignedToName||'',dueDate:staged.dueDate||null,priority:staged.priority||'medium',completed:false,source:'transcript',sourceId:staged.transcriptId,transcriptId:staged.transcriptId,transcriptTitle,calendarEventId:transcript.calendarEventId||staged.calendarEventId||'',calendarEventTitle:staged.calendarEventTitle||transcriptTitle,details:[{transcriptId:staged.transcriptId,transcriptTaskId:staged.taskId,transcriptTitle,calendarEventId:transcript.calendarEventId||staged.calendarEventId||'',calendarEventTitle:staged.calendarEventTitle||transcriptTitle,sourceQuote:staged.sourceQuote}],createdAt:new Date().toISOString()};
  await saveTask(mainTask);await updateStagedTranscriptTask(staged.taskId,{status:'created',needsApproval:false});await logTranscriptAction(staged.transcriptId,'task_created',mainTask.id,'completed');return mainTask;
}
async function processTranscriptPayload(payload){
  const transcript=String(payload.transcript||payload.rawText||'').trim();if(!transcript)throw new Error('Missing transcript');
  const title=transcriptDisplayTitleFromPayload(payload,transcript),sourceId=payload.savedTranscriptId||payload.id||payload.transcriptId||payload.sourceId;if(!sourceId)throw new Error('Transcript must be saved before processing');
  await updateTranscriptIndexStatus(sourceId,{meetingTitle:title,calendarEventId:payload.meetingMatch?.calendarEventId||payload.meetingMatch?.meetingEventId||payload.calendarEventId||payload.calendar_event_id||'',meetingDatetime:payload.meetingMatch?.startTime||payload.meetingDatetime||payload.meeting_datetime||payload.timestamp||null});
  await clearTranscriptStaging(sourceId);await updateTranscriptIndexStatus(sourceId,{processingStatus:'matching_participants',summaryStatus:'pending'});
  const participants=await matchTranscriptParticipants(payload,sourceId,transcript);
  await updateTranscriptIndexStatus(sourceId,{processingStatus:'summarizing'});
  const system=[VAL_SYSTEM_PROMPT,'Create safe, auditable transcript intelligence. Return strict JSON only.','Required keys: executiveSummary, clientSummary, internalNotes, keyDecisions, openQuestions, relationshipUpdates, tasks, contactUpdates, followupDrafts.','tasks: taskTitle, taskDescription, assignedToName, dueDate, priority, confidence (0-1), sourceQuote copied exactly from transcript.','contactUpdates: contactName, contactId if known, fieldToUpdate, oldValue, newValue, reason, confidence (0-1), sourceQuote copied exactly.','Never guess identity or assignment. Use null and low confidence when unclear. Do not extract completed work as a task.'].join('\n');
  let parsed={},modelFailed='';
  try{const raw=await callValModel({system,user:`Meeting: ${title}\n\nTranscript:\n${transcript.slice(0,30000)}`,maxTokens:2600,temperature:0.15,json:true});parsed=JSON.parse(raw);}
  catch(e){
    modelFailed=e.message;const lines=transcript.split(/\n+/).map(line=>line.trim()).filter(Boolean),fallbackTasks=lines.filter(line=>/\b(I|we)\s+(will|need to|can|should)|\b(follow up|send|schedule|review|prepare|update|introduce)\b/i.test(line)&&!/\b(already|completed|finished|sent)\b/i.test(line)).slice(0,12).map(line=>{const split=line.match(/^([^:]{2,80}):\s*(.+)$/),quote=split?split[2]:line,person=split?split[1]:'';return {taskTitle:cleanTaskTitle(quote).replace(/^I\s+will\s+/i,'').replace(/^we\s+will\s+/i,''),taskDescription:'Commitment extracted by the deterministic fallback processor.',assignedToName:person,dueDate:null,priority:'medium',confidence:0.55,sourceQuote:line};}),decisions=lines.filter(line=>/\b(decided|agreed|approved|selected|chose)\b/i.test(line)).slice(0,10);
    parsed={executiveSummary:transcript.replace(/\s+/g,' ').slice(0,900),clientSummary:'',internalNotes:'Automated fallback summary; model processing needs review.',keyDecisions:decisions,openQuestions:lines.filter(line=>/\?$/.test(line)).slice(0,10),relationshipUpdates:[],tasks:fallbackTasks,contactUpdates:[],followupDrafts:[]};
  }
  const summary=await saveTranscriptSummary(sourceId,parsed);await updateTranscriptIndexStatus(sourceId,{summaryStatus:modelFailed?'fallback_complete':'complete',processingStatus:'extracting_actions'});
  if(modelFailed)await logTranscriptAction(sourceId,'failed_action','summary_model','failed',modelFailed);
  const stagedTasks=[],createdTasks=[],createdDrafts=[];
  for(const item of (Array.isArray(parsed.tasks)?parsed.tasks:Array.isArray(parsed.actionItems)?parsed.actionItems:[]).slice(0,20)){
    const assignedName=item.assignedToName||item.assignedPerson||item.person||item.contactName||'',participant=participants.find(p=>looseNameScore(assignedName,p.speakerNameRaw)>=0.8||looseNameScore(assignedName,p.matchedContactName)>=0.8),confidence=Math.max(0,Math.min(1,Number(item.confidence)||0));
    const owner=isOwnerRelationship({name:assignedName,email:participant?.matchedEmail||''}),safeMatch=!!participant&&!participant.needsReview&&participant.matchConfidence>=TRANSCRIPT_SAFE_MATCH_CONFIDENCE;
    const staged={taskId:uuid('tr_task'),transcriptId:sourceId,assignedToContactId:safeMatch?participant.matchedContactId:'',assignedToName:assignedName||participant?.matchedContactName||'',taskTitle:contextualTaskTitle(title,item.taskTitle||item.title),taskDescription:item.taskDescription||item.description||item.notes||'',dueDate:item.dueDate||null,priority:item.priority||'medium',confidence,status:'staged',needsApproval:!(owner||safeMatch),sourceQuote:transcriptSupportingQuote(transcript,item.sourceQuote||item.evidence),calendarEventId:payload.meetingMatch?.calendarEventId||payload.meetingMatch?.meetingEventId||payload.calendarEventId||payload.calendar_event_id||'',calendarEventTitle:title,createdAt:new Date().toISOString()};
    if(!staged.taskTitle)continue;await saveStagedTranscriptTask(staged);stagedTasks.push(staged);if(owner||safeMatch)createdTasks.push(await promoteTranscriptTask(staged));
  }
  for(const item of (Array.isArray(parsed.contactUpdates)?parsed.contactUpdates:[]).slice(0,20)){
    const participant=participants.find(p=>(item.contactId&&p.matchedContactId===item.contactId)||looseNameScore(item.contactName,p.matchedContactName||p.speakerNameRaw)>=0.8);
    await saveStagedContactUpdate({updateId:uuid('tr_update'),transcriptId:sourceId,contactId:participant?.matchedContactId||item.contactId||'',fieldToUpdate:item.fieldToUpdate||item.field||'notes',oldValue:String(item.oldValue||''),newValue:String(item.newValue||''),reason:item.reason||'',sourceQuote:transcriptSupportingQuote(transcript,item.sourceQuote),confidence:Math.max(0,Math.min(1,Number(item.confidence)||0)),approved:false,createdAt:new Date().toISOString()});
  }
  const recapDraft=await saveMeetingRecapDraft({transcriptId:sourceId,title,summary,participants,tasks:stagedTasks,transcriptText:transcript}).catch(async e=>{await logTranscriptAction(sourceId,'failed_action','meeting_recap_draft','failed',e.message).catch(()=>{});return null;});
  if(recapDraft){createdDrafts.push(recapDraft);await logTranscriptAction(sourceId,'email_draft_created',recapDraft.id||'','completed');}
  for(const draft of (Array.isArray(parsed.followupDrafts)?parsed.followupDrafts:[]).slice(0,8)){const body=draft.body||draft.message||'';if(!body.trim())continue;const saved=await saveInternalDraft({draftType:draft.draftType||draft.type||'follow_up',provider:'internal',subject:draft.subject||`Follow-up: ${title}`,body,status:'draft',sourceContext:{source:'transcript_intelligence',transcriptId:sourceId,transcriptTitle:title,draftKind:draft.draftType||draft.type||'follow_up',sourceQuote:transcriptSupportingQuote(transcript,draft.sourceQuote)}});createdDrafts.push(saved);await logTranscriptAction(sourceId,'email_draft_created',saved.id||'','completed');}
  await updateTranscriptIndexStatus(sourceId,{processingStatus:'complete',summaryStatus:modelFailed?'fallback_complete':'complete'});
  return {analysis:parsed,summary,participants,stagedTasks,createdTasks,createdDrafts,counts:{participants:participants.length,tasksExtracted:stagedTasks.length,tasksCreated:createdTasks.length,reviewItems:participants.filter(p=>p.needsReview).length+stagedTasks.filter(t=>t.needsApproval).length}};
}
function transcriptUiRecord(record,{includeText=false}={}){
  const metadata=record.metadata||{};
  const rawText=String(record.rawText||record.raw_text||'');
  const actionItems=Array.isArray(metadata.actionItems)?metadata.actionItems:Array.isArray(metadata.analysis?.actionItems)?metadata.analysis.actionItems:extractOpenLoopsFromText(rawText,`transcript:${record.id}`,record.createdAt).slice(0,12);
  const openActions=actionItems.filter(item=>typeof item==='string'||(!item.completed&&!['done','completed','closed'].includes(String(item.status||'').toLowerCase())));
  const people=Array.isArray(metadata.people)?metadata.people:splitPeopleFromText([record.title,rawText,JSON.stringify(metadata)].join(' ')).slice(0,12);
  const summary=metadata.summary||metadata.analysis?.summary||rawText.replace(/\s+/g,' ').trim().slice(0,420);
  const source=metadata.source||metadata.provider||metadata.platform||record.type||'webhook';
  const reviewStatus=String(metadata.reviewStatus||metadata.review_status||metadata.status||(openActions.length?'needs_review':'unreviewed')).toLowerCase().replace(/\s+/g,'_');
  const createdAt=record.createdAt||metadata.created_at||metadata.timestamp||'';
  const receivedAt=metadata.receivedAt||metadata.received_at||createdAt;
  const title=transcriptDisplayTitleFromPayload({...metadata,...record,title:record.title||metadata.title,metadata},rawText);
  return {
    id:record.id,type:record.type||'transcript',title,
    createdAt,receivedAt,source,status:reviewStatus,reviewStatus,
    summary,preview:rawText.replace(/\s+/g,' ').trim().slice(0,260),contactId:metadata.contact_id||metadata.contactId||'',
    contactName:metadata.contact_name||metadata.contactName||metadata.personName||'',company:metadata.company||metadata.companyName||'',opportunityId:metadata.opportunity_id||metadata.opportunityId||'',
    meetingId:metadata.meeting_id||metadata.meetingId||metadata.calendarEventId||'',relatedOpportunity:metadata.opportunityName||metadata.opportunity||'',
    keyDiscussionPoints:metadata.keyDiscussionPoints||metadata.discussionPoints||[],actionItems,openActionCount:openActions.length,promisedFollowUps:metadata.promisedFollowUps||metadata.followups||actionItems,
    people,sourcePayloadMetadata:metadata,metadata,...(includeText?{transcriptText:rawText}:{})
  };
}
function normalizedTranscriptWebhookPayload(body={}){
  const root=(body.payload&&typeof body.payload==='object'?body.payload:null)||(body.data&&typeof body.data==='object'?body.data:null)||(body.event&&typeof body.event==='object'?body.event:null)||body;
  const transcriptObject=root.transcript&&typeof root.transcript==='object'?root.transcript:{};
  const segments=root.segments||root.sentences||transcriptObject.segments||transcriptObject.sentences||[];
  const segmentText=Array.isArray(segments)?segments.map(segment=>typeof segment==='string'?segment:[segment.speaker||segment.speakerName||'',segment.text||segment.content||segment.transcript||''].filter(Boolean).join(': ')).filter(Boolean).join('\n'):'';
  const transcriptText=[root.transcript,root.rawText,root.raw_text,root.transcriptText,root.transcript_text,root.text,root.content,root.body,transcriptObject.text,transcriptObject.content,segmentText].find(value=>typeof value==='string'&&value.trim())||'';
  const rawTitle=root.title||root.meetingTitle||root.meeting_name||root.callTitle||root.call_name||transcriptObject.title||body.title||'';
  const source=root.source||root.provider||root.platform||body.source||'webhook';
  const sourcePayloadMetadata={};
  for(const [key,value] of Object.entries(body)){
    if(/^(transcript|raw_?text|transcript_?text|text|content|body|segments|sentences)$/i.test(key))continue;
    sourcePayloadMetadata[key]=value&&typeof value==='object'?JSON.parse(JSON.stringify(value,(nestedKey,nestedValue)=>/^(transcript|raw_?text|transcript_?text|text|content|body|segments|sentences)$/i.test(nestedKey)?undefined:nestedValue)):value;
  }
  const metadata={...(body.metadata||{}),...(root.metadata||{}),sourcePayloadMetadata};
  const title=transcriptDisplayTitleFromPayload({...body,...root,title:rawTitle,metadata},transcriptText);
  return {...body,...root,title,source,transcript:transcriptText,metadata,receivedAt:new Date().toISOString(),timestamp:root.timestamp||root.createdAt||root.created_at||root.date||body.timestamp||null};
}
app.get('/api/val/transcripts',async(req,res)=>{
  try{
    console.log('[transcripts] retrieval requested',{userId:VAL_USER_ID,days:req.query.days||'all',limit:req.query.limit||'default'});
    const limit=Math.max(1,Math.min(250,Number(req.query.limit)||100));
    const data=await transcriptIndexData();
    if(data.transcripts.length){const transcripts=data.transcripts.slice(0,limit).map(row=>{const detail=transcriptDetailFromIndex(data,row);delete detail.transcriptText;return detail;});return res.json({ok:true,transcripts,counts:{total:transcripts.length,needsReview:transcripts.filter(t=>t.reviewCount>0).length,withTasks:transcripts.filter(t=>t.taskCount>0).length,failedProcessing:transcripts.filter(t=>/fail|error/i.test(String(t.processingStatus||t.summaryStatus||''))||(t.actionLog||[]).some(a=>a.status==='failed'||a.actionType==='failed_action')).length}});}
    const days=Math.max(1,Math.min(3650,Number(req.query.days)||365)),transcripts=(await transcriptArchiveRecords(days,limit)).map(record=>transcriptUiRecord(record));
    res.json({ok:true,transcripts,counts:{total:transcripts.length,needsReview:transcripts.filter(t=>['new','unreviewed','needs_review'].includes(t.reviewStatus)).length,withOpenActions:transcripts.filter(t=>t.openActionCount>0).length,failedProcessing:transcripts.filter(t=>/fail|error/i.test(String(t.processingStatus||t.summaryStatus||t.status||''))).length}});
  }catch(e){console.error('[transcripts] retrieval failed',e);res.status(500).json({ok:false,error:e.message});}
});
app.get('/api/val/transcripts/review',async(req,res)=>{
  try{const data=await transcriptIndexData();res.json({ok:true,participants:data.participants.filter(row=>row.needsReview),tasks:data.tasks.filter(row=>row.needsApproval),contactUpdates:data.contactUpdates.filter(row=>!row.approved)});}catch(e){res.status(500).json({ok:false,error:e.message});}
});
app.get('/api/val/transcripts/:transcriptId',async(req,res)=>{
  try{
    const id=decodeURIComponent(req.params.transcriptId);
    const data=await transcriptIndexData(id);if(data.transcripts[0]){const transcript=transcriptDetailFromIndex(data,data.transcripts[0]);transcript.drafts=(await listDrafts()).filter(d=>String(d.sourceContext?.transcriptId||'')===String(id));return res.json({ok:true,transcript});}
    const record=(await transcriptArchiveRecords(3650,1000)).find(t=>String(t.id)===id);
    if(!record) return res.status(404).json({ok:false,error:'Transcript not found'});
    const transcript=transcriptUiRecord(record,{includeText:true});transcript.drafts=(await listDrafts()).filter(d=>String(d.sourceContext?.transcriptId||'')===String(id));res.json({ok:true,transcript});
  }catch(e){console.error('[transcripts] detail retrieval failed',e);res.status(500).json({ok:false,error:e.message});}
});
app.post('/api/val/transcripts',async(req,res)=>{
  const payload=normalizedTranscriptWebhookPayload(req.body||{}),transcriptText=payload.transcript||'';
  console.log('[transcripts] webhook received',{title:payload.title,source:payload.source,characters:transcriptText.length});
  if(!transcriptText.trim())return res.status(400).json({ok:false,error:'A usable transcript text field is required. Accepted fields include transcript, rawText, transcriptText, text, content, body, or speaker segments.'});
  try{
    const saved=await saveTranscript({...payload,reviewStatus:payload.reviewStatus||payload.review_status||'new'});
    console.log('[transcripts] saved successfully',{id:saved.id,title:payload.title,source:payload.source});
    const transcriptRecord={id:saved.id,title:payload.title||saved.type,rawText:transcriptText,metadata:payload,createdAt:payload.timestamp||payload.createdAt||payload.receivedAt};
    const meetingMatch=await linkTranscriptToBestMeeting(transcriptRecord).catch(e=>{console.warn('[transcripts] meeting link failed',e.message);return null;});
    if(meetingMatch)await updateTranscriptIndexStatus(saved.id,{meetingTitle:meetingMatch.meetingTitle||meetingMatch.calendarEventTitle,calendarEventId:meetingMatch.calendarEventId||meetingMatch.meetingEventId||''}).catch(()=>{});
    try{
      const processed=await processTranscriptPayload({...payload,savedTranscriptId:saved.id,meetingMatch});
      await updateTranscriptMetadata(saved.id,{analysis:processed.analysis,summary:processed.analysis?.summary||'',actionItems:processed.analysis?.actionItems||[],people:processed.analysis?.people||[],reviewStatus:'needs_review',processedAt:new Date().toISOString()});
      return res.status(201).json({ok:true,...saved,...processed,saved:true,processed:true});
    }catch(processError){
      console.error('[transcripts] processing failed after durable save',{id:saved.id,error:processError.message});
      const fallback={executiveSummary:transcriptText.replace(/\s+/g,' ').slice(0,900),clientSummary:'',internalNotes:'Processing failed; transcript retained for review.',keyDecisions:[],openQuestions:[],relationshipUpdates:[]};
      await saveTranscriptSummary(saved.id,fallback).catch(()=>{});await updateTranscriptIndexStatus(saved.id,{processingStatus:'failed',summaryStatus:'fallback_complete'}).catch(()=>{});await logTranscriptAction(saved.id,'failed_action','pipeline','failed',processError.message).catch(()=>{});
      return res.status(202).json({ok:true,...saved,saved:true,processed:false,processingError:processError.message,meetingMatch});
    }
  }catch(e){console.error('[transcripts] save failed',e);res.status(500).json({ok:false,error:e.message});}
});
app.post('/api/val/transcripts/tasks/:taskId/approve',async(req,res)=>{
  try{const data=await transcriptIndexData(),task=data.tasks.find(row=>row.taskId===req.params.taskId);if(!task)return res.status(404).json({ok:false,error:'Staged task not found'});if(task.status==='created')return res.json({ok:true,task,alreadyCreated:true});const created=await promoteTranscriptTask(task);res.json({ok:true,task:created});}catch(e){res.status(500).json({ok:false,error:e.message});}
});
app.post('/api/val/transcripts/participants/:participantId/approve',async(req,res)=>{
  try{
    const data=await transcriptIndexData(),participant=data.participants.find(row=>row.participantId===req.params.participantId);if(!participant)return res.status(404).json({ok:false,error:'Participant not found'});
    const updates={matchedContactId:req.body.contactId||participant.matchedContactId,matchedContactName:req.body.contactName||participant.matchedContactName,matchedEmail:req.body.email||participant.matchedEmail,matchedPhone:req.body.phone||participant.matchedPhone,matchedCompany:req.body.company||participant.matchedCompany,matchConfidence:1,matchReason:req.body.reason||'User-approved participant match',needsReview:false};
    if(!updates.matchedContactId)return res.status(400).json({ok:false,error:'Choose a specific CRM contact before approving this participant match'});
    if(DEMO_MODE)Object.assign((transcriptDemoArray('transcriptParticipants')||[]).find(row=>row.participantId===participant.participantId),updates);else if(pgPool)await dbQuery('update transcript_participants set matched_contact_id=$1,matched_contact_name=$2,matched_email=$3,matched_phone=$4,matched_company=$5,match_confidence=1,match_reason=$6,needs_review=false where participant_id=$7',[updates.matchedContactId,updates.matchedContactName,updates.matchedEmail,updates.matchedPhone,updates.matchedCompany,updates.matchReason,participant.participantId]);else{const store=valStore();Object.assign(store.transcriptParticipants.find(row=>row.participantId===participant.participantId),updates);saveValStore(store);}await logTranscriptAction(participant.transcriptId,'participant_match_approved',participant.participantId,'completed');res.json({ok:true,participant:{...participant,...updates}});
  }catch(e){res.status(500).json({ok:false,error:e.message});}
});
app.post('/api/val/transcripts/contact-updates/:updateId/approve',async(req,res)=>{
  try{
    const data=await transcriptIndexData(),update=data.contactUpdates.find(row=>row.updateId===req.params.updateId);if(!update)return res.status(404).json({ok:false,error:'Contact update not found'});if(!update.contactId)return res.status(400).json({ok:false,error:'Approve a participant/contact match before applying this update'});
    const allowed={email:'email',phone:'phone',firstName:'firstName',lastName:'lastName',companyName:'companyName',address1:'address1',city:'city',state:'state',postalCode:'postalCode'};const field=allowed[update.fieldToUpdate];if(!field)return res.status(400).json({ok:false,error:'This field cannot be written automatically; keep it as a reviewed intelligence note'});
    try{await ghlStrict('PUT',`/contacts/${encodeURIComponent(update.contactId)}`,{[field]:update.newValue});if(DEMO_MODE){const row=(transcriptDemoArray('transcriptContactUpdates')||[]).find(x=>x.updateId===update.updateId);if(row)row.approved=true;}else if(pgPool)await dbQuery('update transcript_contact_updates set approved=true where update_id=$1',[update.updateId]);else{const store=valStore(),row=store.transcriptContactUpdates.find(x=>x.updateId===update.updateId);if(row)row.approved=true;saveValStore(store);}await logTranscriptAction(update.transcriptId,'contact_updated',update.contactId,'completed');res.json({ok:true,update:{...update,approved:true}});}catch(error){await logTranscriptAction(update.transcriptId,'failed_action',update.contactId,'failed',error.message);throw error;}
  }catch(e){res.status(500).json({ok:false,error:e.message});}
});
app.post('/api/val/transcripts/:transcriptId/actions',async(req,res)=>{
  try{
    const id=decodeURIComponent(req.params.transcriptId),record=(await transcriptArchiveRecords(3650,1000)).find(t=>String(t.id)===id);
    if(!record)return res.status(404).json({ok:false,error:'Transcript not found'});
    const transcript=transcriptUiRecord(record,{includeText:true}),action=String(req.body.action||'');
    if(action==='create_task'){
      const first=(transcript.actionItems||[]).find(item=>typeof item==='string'||(!item.completed&&!['done','completed'].includes(String(item.status||'').toLowerCase())));
      const title=req.body.title||(typeof first==='string'?first:first?.title||first?.text)||`Follow up on ${transcript.title}`;
      const staged={taskId:uuid('tr_task'),transcriptId:transcript.id,assignedToContactId:transcript.contactId||'',assignedToName:transcript.contactName||'',taskTitle:contextualTaskTitle(transcript.title,title),taskDescription:`User-created from transcript: ${transcript.title}`,dueDate:req.body.dueDate||null,priority:req.body.priority||'medium',confidence:1,status:'staged',needsApproval:false,sourceQuote:transcriptSupportingQuote(transcript.transcriptText,req.body.sourceQuote),calendarEventId:transcript.meetingId||'',calendarEventTitle:transcript.title,createdAt:new Date().toISOString()};
      await saveStagedTranscriptTask(staged);const task=await promoteTranscriptTask(staged);return res.json({ok:true,task});
    }
    if(action==='draft_followup'){
      const summary=transcript.summary&&typeof transcript.summary==='object'?transcript.summary:{executiveSummary:transcript.summary||transcript.preview||''};
      const existingTasks=(transcript.tasks||[]).length?transcript.tasks:transcript.actionItems||[];
      const draft=await saveMeetingRecapDraft({transcriptId:transcript.id,title:transcript.title,summary,participants:transcript.participants||[],tasks:existingTasks,transcriptText:transcript.transcriptText||''});
      await logTranscriptAction(transcript.id,'email_draft_created',draft.id||'','completed');return res.json({ok:true,draft});
    }
    if(action==='mark_reviewed'){await updateTranscriptMetadata(id,{reviewStatus:'reviewed',reviewedAt:new Date().toISOString()});return res.json({ok:true,status:'reviewed'});}
    res.status(400).json({ok:false,error:'Unsupported transcript action'});
  }catch(e){console.error('[transcripts] action failed',e);res.status(500).json({ok:false,error:e.message});}
});
app.post('/api/val/transcripts/process',async(req,res)=>{try{const body=normalizedTranscriptWebhookPayload(req.body||{}),transcriptText=body.transcript||'',title=body.title||'Processed transcript';if(!transcriptText.trim())return res.status(400).json({ok:false,error:'Missing transcript'});const saved=await saveTranscript({...body,type:'processed_transcript',title,transcript:transcriptText,importance:3});const transcriptRecord={id:saved.id,title,rawText:transcriptText,metadata:body,createdAt:body.timestamp||body.createdAt||new Date().toISOString()};const meetingMatch=await linkTranscriptToBestMeeting(transcriptRecord).catch(()=>null);if(meetingMatch)await updateTranscriptIndexStatus(saved.id,{meetingTitle:meetingMatch.meetingTitle||meetingMatch.calendarEventTitle,calendarEventId:meetingMatch.calendarEventId||meetingMatch.meetingEventId||''}).catch(()=>{});res.json({ok:true,...saved,...await processTranscriptPayload({...body,transcript:transcriptText,title,savedTranscriptId:saved.id,meetingMatch})});}catch(e){res.status(500).json({error:e.message});}});
app.post('/api/val/conversations',async(req,res)=>{try{res.json({ok:true,...await saveConversation(req.body||{})});}catch(e){res.status(500).json({error:e.message});}});
app.post('/api/val/memory/condense',async(req,res)=>{try{res.json(await condenseOlderMemory());}catch(e){res.status(500).json({ok:false,error:e.message});}});
app.patch('/api/val/conversations/:id',async(req,res)=>{
  try{
    const id=String(req.params.id||''),title=String(req.body?.title||'').trim().slice(0,120);
    if(!title)return res.status(400).json({ok:false,error:'Conversation title is required'});
    await valDbReady;
    if(DEMO_MODE){
      const state=demoState(req,res);const row=(state.savedConversations||[]).find(c=>c.id===id);
      if(row){row.title=title;row.updated_at=new Date().toISOString();}
    }else if(pgPool){
      const result=await dbQuery('update val_conversations set title=$1,updated_at=now() where id=$2 and user_id=$3 returning id,title,updated_at',[title,id,VAL_USER_ID]);
      if(!result.rows[0])return res.status(404).json({ok:false,error:'Conversation not found'});
    }else{
      const store=valStore(),row=store.conversations.find(c=>c.id===id&&c.userId===VAL_USER_ID);
      if(!row)return res.status(404).json({ok:false,error:'Conversation not found'});
      row.title=title;row.updatedAt=new Date().toISOString();saveValStore(store);
    }
    res.json({ok:true,id,title});
  }catch(e){res.status(500).json({ok:false,error:e.message});}
});
app.patch('/api/val/conversations/:id/context',async(req,res)=>{
  try{
    const id=String(req.params.id||''),contact=req.body?.contact&&typeof req.body.contact==='object'?req.body.contact:null,company=String(req.body?.company||contact?.company||'').trim();
    const context=contact?{contact:{id:contact.id||contact.contactId||'',name:contact.name||'',email:contact.email||'',company},confirmedBy:'user',confirmedAt:new Date().toISOString()}:{};
    await valDbReady;
    if(DEMO_MODE){
      const state=demoState(req,res),row=(state.savedConversations||[]).find(c=>c.id===id);if(row)row.metadata={...(row.metadata||{}),context};
    }else if(pgPool){
      const result=await dbQuery("update val_conversations set metadata=coalesce(metadata,'{}'::jsonb)||$1::jsonb,updated_at=now() where id=$2 and user_id=$3 returning id",[JSON.stringify({context}),id,VAL_USER_ID]);
      if(!result.rows[0])return res.status(404).json({ok:false,error:'Conversation not found'});
    }else{
      const store=valStore(),row=store.conversations.find(c=>c.id===id&&c.userId===VAL_USER_ID);if(!row)return res.status(404).json({ok:false,error:'Conversation not found'});row.metadata={...(row.metadata||{}),context};saveValStore(store);
    }
    if(contact)await saveMemoryItem({kind:'conversation_entity_link',summary:`Conversation linked to ${contact.name||contact.email||company}`,rawText:JSON.stringify({conversationId:id,contact,company}),importance:3,metadata:{conversationId:id,contactId:contact.id||contact.contactId||'',contactName:contact.name||'',contactEmail:contact.email||'',company,confirmed:true}});
    res.json({ok:true,id,context});
  }catch(e){res.status(500).json({ok:false,error:e.message});}
});
app.post('/api/val/context/resolve-contact',async(req,res)=>{try{res.json(await resolveContactFromContext(req.body||{}));}catch(e){res.status(500).json({ok:false,error:e.message});}});
app.post('/api/val/context/resolve-meeting',async(req,res)=>{try{res.json(await resolveMeetingContext(req.body||{}));}catch(e){res.status(500).json({ok:false,error:e.message});}});
app.post('/api/val/context/link-transcript',async(req,res)=>{
  try{
    const body=req.body||{};
    const event={id:body.meetingEventId||body.eventId,source:body.meetingSource||body.source||'manual',title:body.title||body.meetingTitle||''};
    const transcript={id:body.transcriptId,title:body.transcriptTitle||'',rawText:body.transcript||body.rawText||'',metadata:body.metadata||{}};
    if(!event.id||!transcript.id) return res.status(400).json({ok:false,error:'Missing meetingEventId or transcriptId'});
    res.json({ok:true,link:await saveMeetingTranscriptLink({event,transcript,confidence:Number(body.confidence)||1,reason:body.reason||'manual link',contactId:body.contactId||''})});
  }catch(e){res.status(500).json({ok:false,error:e.message});}
});
app.get('/api/val/contacts/:contactId/timeline',async(req,res)=>{
  try{
    const contactId=decodeURIComponent(req.params.contactId);
    let contact=null;
    if(contactId&&!contactId.includes('@')&&!/\s/.test(contactId)){
      try{contact=compactContactCandidate(await ghl('GET',`/contacts/${encodeURIComponent(contactId)}`),'ghl_contact');}catch(e){}
    }
    res.json(await buildContactTimeline(contact||contactId,Number(req.query.limit)||80));
  }catch(e){res.status(500).json({ok:false,error:e.message});}
});
app.post('/api/val/meetings/:meetingId/process-after-meeting',async(req,res)=>{
  try{
    const meetingId=decodeURIComponent(req.params.meetingId);
    const context=await resolveMeetingContext({...req.body,calendarEventId:meetingId,eventId:meetingId});
    const processed=[];
    for(const tr of (context.transcripts||[]).slice(0,5)){
      if(!tr.summary) continue;
      processed.push(await processTranscriptPayload({title:tr.title||context.meeting.title||'Meeting transcript',transcript:tr.summary,savedTranscriptId:tr.id,meetingMatch:{meetingEventId:meetingId}}).catch(e=>({ok:false,error:e.message,transcriptId:tr.id})));
    }
    await saveMemoryItem({kind:'after_meeting_context',summary:`After-meeting context: ${context.meeting.title||meetingId}`,rawText:JSON.stringify({meeting:context.meeting,openLoops:context.openLoops,sourcesChecked:context.sourcesChecked}).slice(0,8000),importance:4,metadata:{meetingId,source:'process_after_meeting'}});
    res.json({ok:true,meeting:context.meeting,contactResolution:context.contactResolution,processedTranscripts:processed,openLoops:context.openLoops,tasks:context.tasks,sourcesChecked:context.sourcesChecked});
  }catch(e){res.status(500).json({ok:false,error:e.message});}
});
app.get('/api/val/context-debug',async(req,res)=>{
  try{
    const days=Math.min(Math.max(Number(req.query.days)||30,1),365);
    const [tasks,transcripts,memory,links,drafts]=await Promise.all([
      loadTasks().catch(()=>[]),recentTranscripts(days).catch(()=>[]),recentMemoryItems(days,200).catch(()=>[]),countTranscriptMeetingLinks(days).catch(()=>0),listDrafts().catch(()=>[])
    ]);
    const now=new Date(),past=new Date(now);past.setDate(past.getDate()-days);const future=new Date(now);future.setDate(future.getDate()+14);
    const calendar=await loadContextCalendarEvents(past,future).catch(e=>({events:[],errors:[e.message]}));
    res.json({ok:true,client:CLIENT_CONFIG.clientSlug,days,counts:{tasks:tasks.length,openTasks:tasks.filter(t=>!t.completed).length,transcripts:transcripts.length,memoryItems:memory.length,meetingTranscriptLinks:links,drafts:drafts.length,calendarEvents:calendar.events.length},calendarErrors:calendar.errors||[],sample:{latestTranscript:transcripts[0]||null,latestMemory:memory[0]||null,latestTask:tasks[0]||null}});
  }catch(e){res.status(500).json({ok:false,error:e.message});}
});
function bookDocTypeLabel(type){
  const labels={manuscript:'Manuscript',chapter:'Chapter',outline:'Outline',transcript:'Transcript notes',launch_notes:'Launch notes',prompt_notes:'Prompt notes',knowledge_document:'Knowledge document'};
  return labels[type]||String(type||'Book memory').replace(/_/g,' ');
}
function bookMemoryRecordTitle(record){
  const meta=nestedRecordMetadata(record);
  return meta.chapterTitle||meta.fileName||record.title||record.summary||bookDocTypeLabel(meta.docType||record.type||record.kind);
}
function bookMemoryRecordText(record){
  return String(record.rawText||record.raw_text||record.summary||'').replace(/\s+/g,' ').trim();
}
function inferBookDocTypeFromName(value, fallback='knowledge_document'){
  const text=String(value||'').toLowerCase();
  if(/\b(manuscript|memoir|complete book|full book|chapters?\s*1\s*[-–]\s*\d+|chapters?\s*one\s*[-–]\s*\w+)\b/.test(text)) return 'manuscript';
  if(/\bchapter\s*(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\b/.test(text)) return 'chapter';
  if(/\boutline\b/.test(text)) return 'outline';
  if(/\bprompt|ifs\b/.test(text)) return 'prompt_notes';
  if(/\blaunch|podcast\b/.test(text)) return 'launch_notes';
  return fallback;
}
function uniqueBookDocRecords(records){
  const seen=new Set(), out=[];
  for(const record of records){
    const meta=nestedRecordMetadata(record);
    const sourceKey=meta.transcriptId||meta.fileName||'';
    const key=(sourceKey
      ? [sourceKey,meta.docType||record.type||record.kind||''].join('|')
      : [record.id||'',meta.chapterNumber||'',meta.chapterTitle||'',meta.docType||record.type||record.kind||'',record.title||record.summary||''].join('|')
    ).toLowerCase();
    if(seen.has(key)) continue;
    seen.add(key);
    out.push(record);
  }
  return out;
}
function buildBookState({tasks,transcripts,memory,drafts}){
  const project=CLIENT_CONFIG.projectName||CLIENT_CONFIG.brandName||'the book';
  const bookRecords=uniqueBookDocRecords([...(transcripts||[]),...(memory||[])].filter(item=>{
    const meta=nestedRecordMetadata(item);
    const type=String(meta.docType||item.type||item.kind||'').toLowerCase();
    const haystack=[meta.project,meta.projectType,meta.fileName,item.title,item.summary,type].join(' ').toLowerCase();
    return isBookEditorProject() && (
      haystack.includes('book_editor') ||
      haystack.includes(String(project).toLowerCase()) ||
      ['manuscript','chapter','outline','transcript','launch_notes','prompt_notes','knowledge_document'].includes(type)
    );
  }));
  const openTasks=(tasks||[]).filter(t=>!t.completed);
  const recent=bookRecords[0]||null;
  const chapters=bookRecords.filter(r=>String(nestedRecordMetadata(r).docType||r.type||r.kind||'').toLowerCase()==='chapter');
  const manuscripts=bookRecords.filter(r=>String(nestedRecordMetadata(r).docType||r.type||r.kind||'').toLowerCase()==='manuscript');
  const outlines=bookRecords.filter(r=>String(nestedRecordMetadata(r).docType||r.type||r.kind||'').toLowerCase()==='outline');
  const promptNotes=bookRecords.filter(r=>String(nestedRecordMetadata(r).docType||r.type||r.kind||'').toLowerCase()==='prompt_notes');
  const launchNotes=bookRecords.filter(r=>String(nestedRecordMetadata(r).docType||r.type||r.kind||'').toLowerCase()==='launch_notes');
  const chapterNumbers=[...new Set(chapters.map(r=>nestedRecordMetadata(r).chapterNumber).filter(Boolean))].sort((a,b)=>Number(a)-Number(b));
  const nextSteps=openTasks.slice(0,5).map(t=>t.title).filter(Boolean);
  if(!nextSteps.length){
    if(!bookRecords.length) nextSteps.push('Upload the manuscript, chapter drafts, outline, or latest editorial notes.');
    nextSteps.push('Ask Michele VAL where you left off and what the next clean editorial move should be.');
    nextSteps.push('Run an alignment review across chapter order, humor, emotional arc, and IFS prompts.');
  }
  const alignmentSignals=[
    !outlines.length?'No outline or chapter map found yet.':'Chapter map or outline is available.',
    manuscripts.length||chapters.length?'Manuscript/chapter material is available.':'No manuscript or chapter file found yet.',
    promptNotes.length?'Prompt notes are available for IFS review.':'IFS prompts have not been isolated in memory yet.',
    launchNotes.length?'Launch/podcast notes are available.':'Launch and podcast notes are not loaded yet.'
  ];
  return {
    ok:true,
    project,
    phase:bookRecords.length?'Editing continuity':'Needs manuscript context',
    lastWorkedOn:recent?{
      title:bookMemoryRecordTitle(recent),
      type:bookDocTypeLabel(nestedRecordMetadata(recent).docType||recent.type||recent.kind),
      createdAt:recent.createdAt||recent.created_at||'',
      excerpt:bookMemoryRecordText(recent).slice(0,240)
    }:null,
    counts:{documents:bookRecords.length,chapters:chapterNumbers.length||chapters.length,openTasks:openTasks.length,drafts:(drafts||[]).length},
    chapterNumbers,
    nextSteps,
    alignmentSignals,
    feedItems:[
      {color:'gold',type:'book_state',text:recent?`Last worked on: ${bookMemoryRecordTitle(recent)}`:`Upload ${project} manuscript or notes to establish continuity.`,time:'Book state'},
      {color:'navy',type:'next_step',text:nextSteps[0]||'Ask what to work on next.',time:'Next move'},
      {color:'green',type:'alignment',text:'Check chapter flow, humor, emotional arc, IFS prompts, and reader transformation together.',time:'Alignment'},
      {color:'amber',type:'memory',text:`${bookRecords.length} book memory item${bookRecords.length===1?'':'s'} available.`,time:'Memory'}
    ]
  };
}
app.get('/api/val/book-state',async(req,res)=>{
  try{
    if(!isBookEditorProject()) return res.status(404).json({ok:false,error:'Book editor mode is not enabled.'});
    const [tasks,transcripts,memory,drafts]=await Promise.all([
      loadTasks().catch(()=>[]),
      recentTranscripts(365).catch(()=>[]),
      recentMemoryItems(365,500).catch(()=>[]),
      listDrafts().catch(()=>[])
    ]);
    res.json(buildBookState({tasks,transcripts,memory,drafts}));
  }catch(e){res.status(500).json({ok:false,error:e.message});}
});
app.get('/api/val/conversations',async(req,res)=>{try{if(DEMO_MODE){const state=demoState(req,res);const rows=[...(state.savedConversations||[]),{id:'demo-chat-1',title:'Morning Relationship Briefing',source:'chat',metadata:{demo:true},created_at:demoIso(0,8,0),updated_at:demoIso(0,8,12)},{id:'demo-chat-2',title:'Pipeline Priorities Review',source:'chat',metadata:{demo:true},created_at:demoIso(-1,15,30),updated_at:demoIso(-1,15,48)},{id:'demo-chat-3',title:'Meeting Follow-Up Drafts',source:'chat',metadata:{demo:true},created_at:demoIso(-2,10,0),updated_at:demoIso(-2,10,25)}];return res.json(rows.slice(0,Number(req.query.limit)||25));}await valDbReady;if(pgPool){const r=await dbQuery('select id,title,source,metadata,created_at,updated_at from val_conversations where user_id=$1 order by updated_at desc limit $2',[VAL_USER_ID,Number(req.query.limit)||25]);return res.json(r.rows);}res.json(valStore().conversations.slice(0,Number(req.query.limit)||25));}catch(e){res.status(500).json({error:e.message});}});
app.get('/api/val/conversations/:id/messages',async(req,res)=>{try{if(DEMO_MODE){const state=demoState(req,res);const sets={'demo-chat-1':[{role:'user',content:'What needs my attention today?',created_at:demoIso(0,8,0)},{role:'assistant',content:withDemoCta('Marcus needs the pilot memo before the 2 PM demo. Elena needs the scope revision. Jordan has a warm intro offer that should not sit.'),created_at:demoIso(0,8,1)}],'demo-chat-2':[{role:'user',content:'Show me pipeline risk.',created_at:demoIso(-1,15,30)},{role:'assistant',content:withDemoCta('HealthBridge is the risk. The expansion is not blocked by value. It is blocked by sponsor fatigue and implementation load.'),created_at:demoIso(-1,15,31)}],'demo-chat-3':[{role:'user',content:'Draft the follow-ups.',created_at:demoIso(-2,10,0)},{role:'assistant',content:withDemoCta('I would queue three drafts: Marcus pilot memo, Elena revised scope, and Jordan one-paragraph intro ask.'),created_at:demoIso(-2,10,1)}]};return res.json(state.savedConversationMessages?.[req.params.id]||sets[req.params.id]||[]);}await valDbReady;if(pgPool){const r=await dbQuery('select role,content,metadata,created_at from val_messages where conversation_id=$1 order by created_at asc',[req.params.id]);return res.json(r.rows);}res.json(valStore().messages.filter(m=>m.conversationId===req.params.id));}catch(e){res.status(500).json({error:e.message});}});
app.post('/api/val/meeting-briefing',async(req,res)=>{
  try{
    if(DEMO_MODE){
      const input=req.body||{};
      const meeting={...input,id:input.eventId||input.id,title:input.title||input.summary||'',source:input.source||'demo',attendees:Array.isArray(input.attendees)?input.attendees:[]};
      const state=demoState(req,res);
      return res.json(demoMeetingBriefingResponse(state,meeting));
    }
    const input=req.body||{};
    let meeting={...input,id:input.eventId||input.id,title:input.title||input.summary||'',source:input.source||'unknown',attendees:Array.isArray(input.attendees)?input.attendees:[]};
    if(meeting.source==='google'&&meeting.id){
      const token=await getGoogleToken();
      if(token){
        const r=await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(meeting.id)}?maxAttendees=50`,{headers:{Authorization:`Bearer ${token}`}});
        const full=await readJsonResponse(r);
        if(r.ok) meeting={...mapGoogleEvent(full),eventId:full.id};
      }
    }
    const unified=await resolveMeetingContext({...meeting,calendarEventId:meeting.id,eventId:meeting.eventId||meeting.id});
    const attendees=unified.meeting.attendees||inferAttendeesFromEvent(meeting);
    const transcripts=unified.transcripts||[];
    const tasks=unified.tasks||[];
    const openLoops=unified.openLoops||[];
    const gmailRawContext=unified.relationshipContext?.emailContext?.filter(e=>e.provider!=='outlook')||[];
    const gmailContext=gmailRawContext.map(e=>gmailMeetingContextShape(e,'Matched attendee, company, or meeting keyword')).slice(0,8);
    const outlookContext=unified.relationshipContext?.emailContext?.filter(e=>e.provider==='outlook')||[];
    const memoryItems=unified.relationshipContext?.relatedMemory||[];
    const ghlNotes=unified.relationshipContext?.ghlNotes||'';
    const noPriorContext=!transcripts.length&&!tasks.length&&!memoryItems.length&&!gmailContext.length&&!outlookContext.length&&!ghlNotes&&!openLoops.length;
    const context=[
      'Meeting: '+(unified.meeting.title||unified.meeting.summary||meeting.title||meeting.summary||'(No title)'),
      attendees.length?'Attendees: '+attendees.map(a=>a.name||a.email).join(', '):'Attendees: unclear',
      unified.contactResolution?.contact?'Resolved contact: '+[unified.contactResolution.contact.name,unified.contactResolution.contact.email,unified.contactResolution.contact.company].filter(Boolean).join(' | '):'Resolved contact: none',
      unified.sourcesChecked?.length?'Sources checked:\n- '+unified.sourcesChecked.join('\n- '):'',
      gmailContext.length?'Recent Gmail context:\n'+gmailContext.slice(0,5).map(e=>`- ${e.subject} from ${e.from||'unknown'}: ${e.summary}`).join('\n'):'No Gmail context found. Searched attendee emails, attendee names, company names, meeting title keywords, and recent threads where available.',
      outlookContext.length?'Recent Outlook context:\n'+outlookContext.slice(0,5).map(e=>`- ${e.subject} from ${e.from?.email||e.from?.name||'unknown'}: ${e.snippet||e.bodyPreview||''}`).join('\n'):'',
      transcripts.length?'Transcript context:\n'+transcripts.map(t=>`- ${t.title}: ${t.summary}`).join('\n'):'',
      tasks.length?'Open tasks:\n'+tasks.map(t=>`- ${t.title}`).join('\n'):'',
      memoryItems.length?'Relationship memory:\n'+memoryItems.map(m=>`- ${m.summary||m.kind}: ${String(m.rawText||'').slice(0,450)}`).join('\n'):'',
      ghlNotes?'Contact notes:\n'+ghlNotes:'',
      noPriorContext?'No prior context found after checking contacts, past meetings, transcripts, emails, tasks, and memory. Say that clearly and then give a lightweight prep based only on the current event.':''
    ].filter(Boolean).join('\n\n');
    const briefing=await callValModel({system:[VAL_SYSTEM_PROMPT,'Create a concise meeting briefing from only the supplied context. Include what matters, risks, open loops, suggested questions, and follow-up recommendations.'].join('\n\n'),user:context,maxTokens:1200,temperature:0.25});
    res.json({ok:true,meeting:{...unified.meeting,attendees},contactResolution:unified.contactResolution,relationshipContext:unified.relationshipContext,gmailContext,transcriptContext:transcripts,taskContext:tasks,memoryContext:memoryItems,contactNotes:ghlNotes?ghlNotes.split('\n\n').slice(0,6):[],briefing,openLoops,sourcesChecked:unified.sourcesChecked,contextErrors:unified.errors||[],suggestedQuestions:[],recommendedFollowUps:[]});
  }catch(e){res.status(500).json({ok:false,error:e.message});}
});
app.get('/api/relationships/review',async(req,res)=>{
  try{
    if(DEMO_MODE){
      return res.json(demoRelationshipReview(demoState(req,res),Number(req.query.windowDays)||7));
    }
    const windowDays=Math.min(Math.max(Number(req.query.windowDays)||7,1),90);
    res.json(await buildRelationshipReview({windowDays}));
  }catch(e){
    res.status(500).json({ok:false,error:e.message});
  }
});
app.post('/api/relationships/actions',async(req,res)=>{
  try{
    const action=String(req.body.action||'').trim();
    const contact=req.body.contact||{};
    if(!contact.name&&!contact.email) return res.status(400).json({ok:false,error:'Missing contact'});
    if(action==='draft_message'){
      const draft=await saveInternalDraft({draftType:'relationship_outreach',provider:'internal',subject:req.body.subject||contact.draftOutreach?.subject||`Follow-up with ${contact.name||contact.email}`,body:req.body.body||contact.draftOutreach?.body||draftRelationshipOutreach(contact).body,sourceContext:{source:'relationship_review',contact}});
      return res.json({ok:true,draft});
    }
    if(action==='create_task'){
      const defaultDue=new Date(Date.now()+2*24*60*60*1000).toISOString();
      const task={id:uuid('task'),title:req.body.title||contact.recommendedAction||`Follow up with ${contact.name||contact.email}`,contactName:contact.name||contact.email||'',contactId:contact.contactId||contact.id||'',dueDate:req.body.dueDate||defaultDue,priority:req.body.priority||((contact.score||0)>=70?'high':'medium'),notes:req.body.notes||`${contact.reason||'Created from Relationship Review.'}\n\nRecommended action: ${contact.recommendedAction||'Review relationship history.'}`,details:[{text:'Created from Relationship Review',ts:new Date().toISOString()}],completed:false,createdAt:new Date().toISOString()};
      await saveTask(task);
      return res.json({ok:true,task});
    }
    if(['mark_vip','snooze','not_important'].includes(action)){
      const until=action==='snooze'?(req.body.until||new Date(Date.now()+7*24*60*60*1000).toISOString()):'';
      await saveMemoryItem({kind:'relationship_preference',summary:`${action}: ${contact.name||contact.email}`,rawText:JSON.stringify({action,contact,until}),importance:action==='mark_vip'?4:2,metadata:{source:'relationship_review',action,contact,until,identityKey:personKey(contact.name,contact.email)}});
      return res.json({ok:true,status:'saved',action,until});
    }
    if(action==='brainstorm'){
      if(DEMO_MODE){
        const ideas=[
          `Value-add idea for ${contact.name||contact.email}: send one specific artifact that reduces their next decision, not a broad check-in.`,
          contact.openLoops?.length?`Open loops to close: ${contact.openLoops.join(', ')}.`:'First clarify the open loop before writing anything.',
          `Best VAL move: draft the message, create the task, and attach the outcome to the relationship so it does not disappear after the conversation.`,
          'Capacity guard: do not turn this into a new project unless one current commitment closes first.'
        ].join('\n\n');
        return res.json({ok:true,content:ideas,demo:true});
      }
      const evidence=(contact.evidence||[]).map(e=>`- [${e.type}] ${e.summary}`).join('\n');
      const content=await callValModel({system:[VAL_SYSTEM_PROMPT,'Brainstorm specific, evidence-based ways to strengthen one relationship. Do not invent facts. Give practical value-add ideas, useful introductions, follow-up topics, strategic conversations, and collaboration ideas.'].join('\n\n'),user:`Contact: ${contact.name||contact.email}\nScore: ${contact.score||''}\nRecommended action: ${contact.recommendedAction||''}\nEvidence:\n${evidence||'No evidence supplied.'}`,maxTokens:900,temperature:0.35});
      return res.json({ok:true,content});
    }
    res.status(400).json({ok:false,error:'Unsupported action'});
  }catch(e){res.status(500).json({ok:false,error:e.message});}
});
app.post('/api/val/intelligence',async(req,res)=>{
  try{
    const action=req.body.action||'what_now',query=req.body.query||'',dashboard=req.body.dashboard||{},tasks=Array.isArray(req.body.tasks)?req.body.tasks:[];
    if(DEMO_MODE){const s=demoState(req,res);return res.json({ok:true,action,content:demoIntelligenceResponse(action,query,s),demo:true});}
    const uploadedDocs=await uploadedValDocumentContextForQuery(`${action} ${query}`).catch(e=>`Uploaded VAL document lookup failed: ${e.message}`);
    const [memory,ghlContext,googleDocs]=await Promise.all([
      recentMemoryContext(`${action} ${query}`),
      ghlPlatformContext(`${action} ${query} ${JSON.stringify(dashboard).slice(0,2500)}`,dashboard),
      uploadedDocs?Promise.resolve(''):googleDocsContextForQuery(`${action} ${query}`).catch(e=>`Google Docs lookup failed: ${e.message}`)
    ]);
    const system=[VAL_SYSTEM_PROMPT,'Use uploaded VAL document source text, saved memory, Google Docs source text, dashboard data, platform-wide GHL MCP context, task state, and the requested action. Be specific, practical, and decisive. If uploaded VAL document source text is present, treat it as visible source material and do not ask for Drive, Docs, or pasted chunks. Do not begin with source/upload/readability status unless the user explicitly asks whether you can read or access the manuscript.','For Michele book/editor responses, every time you name work the user should do, include a "To-do list" section with only the 1 to 5 highest-priority new or updated actions. Do not repeat the entire existing task list. Each to-do must be one concrete action line with enough context to understand why it matters, such as chapter, section, reason, or source. Do not leave recommendations only in prose. For priority/next-step requests, keep the whole chat answer short and let the task board hold the longer list.',memory?'Relevant saved memory:\n'+memory:'',uploadedDocs?'Relevant uploaded VAL document source:\n'+uploadedDocs:'',googleDocs?'Relevant Google Docs source:\n'+googleDocs:'',ghlContext?'Platform-wide GHL MCP context:\n'+ghlContext:''].filter(Boolean).join('\n\n');
    const user=['Requested VAL action: '+action,'Instruction: '+actionPrompt(action),query?'User query: '+query:'','Dashboard JSON: '+JSON.stringify(dashboard).slice(0,9000),'Tasks JSON: '+JSON.stringify(tasks).slice(0,9000)].filter(Boolean).join('\n\n');
    const actionMaxTokens=/^(book_next_steps|editorial_next_steps)$/i.test(action)?650:1800;
    const content=await callValModel({system,user,maxTokens:actionMaxTokens,temperature:0.35});
    const createdTasks=await persistAutoTasksFromValResponse({content,userQuery:query||action,action,source:'val_intelligence'}).catch(e=>{console.warn('Auto task capture failed:',e.message);return [];});
    res.json({ok:true,action,content,createdTasks,ghlContextAvailable:!!ghlContext});
  }catch(e){res.status(500).json({error:e.message});}
});
app.post('/api/val/chat',async(req,res)=>{
  try{
    const messages=Array.isArray(req.body.messages)?req.body.messages:[],lastUser=[...messages].reverse().find(m=>m.role==='user')?.content||'',memoryQuery=messages.slice(-10).map(m=>m.content||'').join('\n').slice(-6000),dashboard=req.body.dashboard||{};
    if(DEMO_MODE){const s=demoState(req,res);return res.json({message:{role:'assistant',content:demoChatResponse(lastUser,s)},demo:true});}
    if(isGoallTestContactRequest(lastUser)){
      const result=await createOrUpdateGoallTestContact();
      return res.json({message:{role:'assistant',content:goallTestContactSummary(result)},ghlContact:result});
    }
    const inferredGhlAction=await inferGhlActionFromChat(lastUser);
    if(inferredGhlAction){
      const result=await executeValGhlAction(inferredGhlAction);
      return res.json({message:{role:'assistant',content:result.content||'Done.'},ghlAction:result});
    }
    if(isGoogleDocRewriteRequest(lastUser)){
      try{
        const result=await rewriteGoogleDocChapter({query:lastUser,mode:'create'});
        const scopeLabel=result.source.scope==='chapter'?'chapter':'document';
        const content=[
          `Done. I rewrote the full ${scopeLabel} from ${result.source.title} as a new Google Doc.`,
          '',
          `Source: ${result.source.url}`,
          `Rewrite: ${result.output.url}`,
          '',
          `I kept the full rewrite out of chat so you can review and edit it in Docs.`
        ].join('\n');
        return res.json({message:{role:'assistant',content},googleDocRewrite:result});
      }catch(e){
        if(/auth|required|scope|reconnect/i.test(e.message)){
          return res.json({message:{role:'assistant',content:'I can use the memoir already uploaded into VAL as the source. Google only needs to be reconnected so I can create the rewritten Google Doc output. Open Integration Status, reconnect Google, and approve the Drive/Docs permissions.'}});
        }
        return res.json({message:{role:'assistant',content:`I tried to rewrite it from the uploaded VAL memoir or Google Docs, but I could not find a readable matching document yet: ${e.message}\n\nUse the exact uploaded file title, Google Doc title, or Google Doc URL, then ask me to rewrite it.`}});
      }
    }
    const availabilityDoc=await readValUploadedRewriteSource({query:lastUser+'\n'+memoryQuery}).catch(()=>null);
    if(availabilityDoc&&/\b(can you|could you|do you|are you able to)\b[\s\S]{0,80}\b(read|see|access|open)\b/i.test(lastUser)&&/\b(manuscript|memoir|book|document|doc|draft)\b/i.test(lastUser)){
      return res.json({message:{role:'assistant',content:[
        `Yes. I can read the manuscript already uploaded into VAL.`,
        '',
        `Source: ${availabilityDoc.title}`,
        `Readable characters: ${availabilityDoc.text.length}`,
        '',
        `Google Drive is only needed if you want me to create or update a Google Doc output. For reading and editorial review, I can use the uploaded VAL manuscript.`
      ].join('\n')}});
    }
    const uploadedDocs=await uploadedValDocumentContextForQuery(lastUser+'\n'+memoryQuery).catch(e=>`Uploaded VAL document lookup failed: ${e.message}`);
    const [memory,ghlContext,googleDocs]=await Promise.all([
      recentMemoryContext(lastUser+'\n'+memoryQuery),
      ghlPlatformContext(lastUser+'\n'+memoryQuery,dashboard),
      uploadedDocs?Promise.resolve(''):googleDocsContextForQuery(lastUser+'\n'+memoryQuery).catch(e=>`Google Docs lookup failed: ${e.message}`)
    ]);
    const system=[VAL_SYSTEM_PROMPT,'Use dashboard context, uploaded VAL document source text, Google Docs source text, platform-wide GHL MCP context, and saved memory when relevant. Do not pretend to know facts that are not present.','When Relevant uploaded VAL document source is present, use it directly. Do not ask for Google Drive, Google Docs, pasted chunks, or uploads. Say plainly that the manuscript is available in VAL only if the user asks whether you can read or access it. Do not begin ordinary editorial responses with source/upload/readability status.','For Michele book/editor responses, every time you name work the user should do, include a "To-do list" section with only the 1 to 5 highest-priority new or updated actions. Do not repeat the entire existing task list. Each to-do must be one concrete action line with enough context to understand why it matters, such as chapter, section, reason, or source. Do not leave recommendations only in prose. For priority/next-step requests, keep the whole chat answer short and let the task board hold the longer list.','When Recent saved VAL memory contains knowledge_document, processed_transcript, or transcript entries, the text after the colon is available source content. Use it directly. Do not say the document or transcript text is not visible unless no relevant memory entries are present.','When Relevant Google Docs source is present, use it directly. Do not ask the user to paste the document or send it in chunks. If Google Docs says reconnect is required, tell the user to reconnect Google from Integration Status and approve Drive/Docs permissions.','When Platform-wide GHL MCP context is present, use GHL contacts, opportunities, tasks, conversations, notes, and call transcripts as current CRM source context.',memory?'Recent saved VAL memory:\n'+memory:'',uploadedDocs?'Relevant uploaded VAL document source:\n'+uploadedDocs:'',googleDocs?'Relevant Google Docs source:\n'+googleDocs:'',ghlContext?'Platform-wide GHL MCP context:\n'+ghlContext:''].filter(Boolean).join('\n\n');
    const content=await callOpenAIResponses({system,messages,maxTokens:1900,temperature:0.7});
    const finalContent=content||'I could not process that.';
    const createdTasks=await persistAutoTasksFromValResponse({content:finalContent,userQuery:lastUser,action:'chat',source:'val_chat'}).catch(e=>{console.warn('Auto task capture failed:',e.message);return [];});
    res.json({message:{role:'assistant',content:finalContent},createdTasks,ghlContextAvailable:!!ghlContext});
  }catch(e){res.status(500).json({error:e.message});}
});

async function extractUploadedText(file){
  const name=file.originalname||'uploaded-file', mime=file.mimetype||'', ext=path.extname(name).toLowerCase();
  if(mime.startsWith('text/')||['.txt','.md','.markdown','.html','.htm','.json','.csv','.tsv'].includes(ext)) return file.buffer.toString('utf8');
  if(mime==='application/pdf'||ext==='.pdf') return (await pdfParse(file.buffer)).text||'';
  if(mime==='application/vnd.openxmlformats-officedocument.wordprocessingml.document'||ext==='.docx') return (await mammoth.extractRawText({buffer:file.buffer})).value||'';
  throw new Error('Unsupported file type. Upload TXT, MD, HTML, JSON, CSV, PDF, or DOCX.');
}
app.post('/api/val/files',upload.any(),async(req,res)=>{
  try{
    const files=(req.files||[]).filter(Boolean);
    if(!files.length)return res.status(400).json({error:'Missing file'});
    const savedFiles=[];
    for(const file of files.slice(0,10)){
      const text=(await extractUploadedText(file)).trim();
      if(!text) throw new Error(`No readable text found in ${file.originalname}`);
      const inferredDocType=inferBookDocTypeFromName([req.body.title,file.originalname].filter(Boolean).join(' '),req.body.docType||'knowledge_document');
      const metadata={
        fileName:file.originalname,
        mimeType:file.mimetype,
        size:file.size,
        project:req.body.project||CLIENT_CONFIG.projectName||CLIENT_CONFIG.brandName||'',
        client:req.body.client||CLIENT_CONFIG.clientName||'',
        docType:inferredDocType,
        chapterNumber:req.body.chapterNumber||'',
        chapterTitle:req.body.chapterTitle||'',
        canonicalManuscript:inferredDocType==='manuscript',
        projectType:CLIENT_CONFIG.projectType||''
      };
      const saved=await saveTranscript({
        type:'knowledge_document',
        title:req.body.title||file.originalname,
        transcript:text,
        timestamp:new Date().toISOString(),
        source:'val_file_upload',
        importance:isBookEditorProject()?4:3,
        metadata
      });
      savedFiles.push({...saved,fileName:file.originalname,chars:text.length,metadata});
    }
    res.json({ok:true,...savedFiles[0],files:savedFiles,fileName:savedFiles[0]?.fileName,chars:savedFiles.reduce((n,f)=>n+(f.chars||0),0)});
  }catch(e){res.status(500).json({error:e.message});}
});

// ════════════════════════════════════════════════════════
const PORT=process.env.PORT||3000;
app.listen(PORT,()=>{
  console.log(`VAL proxy running on port ${PORT}`);
  setTimeout(()=>condenseOlderMemory().catch(e=>console.error('Memory condensation failed:',e.message)),15000);
  setInterval(()=>condenseOlderMemory().catch(e=>console.error('Memory condensation failed:',e.message)),24*60*60*1000).unref();
});
