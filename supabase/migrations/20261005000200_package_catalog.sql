-- User-provided Digital Government Forum 2026 package catalogue.
-- Pricing: source pages 10, 12 and 17. Benefits: pages 11, 13, 14 and 17.
-- Add missing definitions only; preserve existing packages and sponsor data.
with catalog as (
  select (entry->>'id')::uuid as id, entry - 'id' as data
  from jsonb_array_elements($catalog$
[
  {
    "id": "720fe611-faa0-4b7f-b5a0-ec32e6b43001",
    "name": "Digital Transformation Sponsor",
    "referenceValue": 2000000,
    "benefits": [
      "One special benefit to be agreed later.",
      "Participation in paid digital campaigns on social media platforms.",
      "Participation by the partner's Chairperson or CEO in a session on the main stage, coordinated and confirmed within two weeks of sponsorship confirmation.",
      "Three VVIP seats for the partner's representatives to attend the forum at the main stage.",
      "Twenty invitations for the partner's leadership to attend the opening ceremony.",
      "A large booth within the Digital Saudi Exhibition.",
      "Prominent placement of the partner's name and logo on all forum promotional print materials, press announcements, invitation cards and marketing brochures.",
      "Placement of the partner's name and logo in commercial advertisements and indoor and outdoor banners, including the attendee-area backdrop.",
      "A distinctive recognition plaque for the partnership category, presented at the forum's opening ceremony.",
      "Allocated time on the Digital Saudi stage to showcase the partner's digital transformation initiatives."
    ]
  },
  {
    "id": "720fe611-faa0-4b7f-b5a0-ec32e6b43002",
    "name": "Cybersecurity Sponsor",
    "referenceValue": 2000000,
    "benefits": [
      "One special benefit to be agreed later.",
      "Participation in paid digital campaigns on social media platforms.",
      "Participation by the partner's Chairperson or CEO in a session on the main stage, coordinated and confirmed within two weeks of sponsorship confirmation.",
      "Three VVIP seats for the partner's representatives to attend the forum at the main stage.",
      "Twenty invitations for the partner's leadership to attend the opening ceremony.",
      "A large booth within the Digital Saudi Exhibition.",
      "Prominent placement of the partner's name and logo on all forum promotional print materials, press announcements, invitation cards and marketing brochures.",
      "Placement of the partner's name and logo in commercial advertisements and indoor and outdoor banners, including the attendee-area backdrop.",
      "A distinctive recognition plaque for the partnership category, presented at the forum's opening ceremony.",
      "Allocated time on the Digital Saudi stage to showcase the partner's digital transformation initiatives."
    ]
  },
  {
    "id": "720fe611-faa0-4b7f-b5a0-ec32e6b43003",
    "name": "Artificial Intelligence Sponsor",
    "referenceValue": 2000000,
    "benefits": [
      "One special benefit to be agreed later.",
      "Participation in paid digital campaigns on social media platforms.",
      "Participation by the partner's Chairperson or CEO in a session on the main stage, coordinated and confirmed within two weeks of sponsorship confirmation.",
      "Three VVIP seats for the partner's representatives to attend the forum at the main stage.",
      "Twenty invitations for the partner's leadership to attend the opening ceremony.",
      "A large booth within the Digital Saudi Exhibition.",
      "Prominent placement of the partner's name and logo on all forum promotional print materials, press announcements, invitation cards and marketing brochures.",
      "Placement of the partner's name and logo in commercial advertisements and indoor and outdoor banners, including the attendee-area backdrop.",
      "A distinctive recognition plaque for the partnership category, presented at the forum's opening ceremony.",
      "Allocated time on the Digital Saudi stage to showcase the partner's digital transformation initiatives."
    ]
  },
  {
    "id": "720fe611-faa0-4b7f-b5a0-ec32e6b43004",
    "name": "Cloud Services Sponsor",
    "referenceValue": 2000000,
    "benefits": [
      "One special benefit to be agreed later.",
      "Participation in paid digital campaigns on social media platforms.",
      "Participation by the partner's Chairperson or CEO in a session on the main stage, coordinated and confirmed within two weeks of sponsorship confirmation.",
      "Three VVIP seats for the partner's representatives to attend the forum at the main stage.",
      "Twenty invitations for the partner's leadership to attend the opening ceremony.",
      "A large booth within the Digital Saudi Exhibition.",
      "Prominent placement of the partner's name and logo on all forum promotional print materials, press announcements, invitation cards and marketing brochures.",
      "Placement of the partner's name and logo in commercial advertisements and indoor and outdoor banners, including the attendee-area backdrop.",
      "A distinctive recognition plaque for the partnership category, presented at the forum's opening ceremony.",
      "Allocated time on the Digital Saudi stage to showcase the partner's digital transformation initiatives."
    ]
  },
  {
    "id": "720fe611-faa0-4b7f-b5a0-ec32e6b43005",
    "name": "Gold Partner",
    "referenceValue": 1000000,
    "benefits": [
      "A distinctive recognition plaque for the partnership category, presented at the forum's opening ceremony.",
      "Participation in paid digital campaigns on social media platforms.",
      "Participation by the partner's Chairperson or CEO in a session on the main stage, coordinated and confirmed within two weeks of sponsorship confirmation.",
      "Two VVIP seats for the partner's representatives to attend the forum at the main stage.",
      "Twenty invitations for the partner's leadership to attend the opening ceremony.",
      "A medium-sized booth within the Digital Saudi Exhibition.",
      "Prominent placement of the partner's name and logo on all forum promotional print materials, press announcements, invitation cards and marketing brochures.",
      "Placement of the partner's name and logo in commercial advertisements and indoor and outdoor banners, including the attendee-area backdrop.",
      "Allocated time on the Digital Saudi stage to showcase the partner's digital transformation initiatives."
    ]
  },
  {
    "id": "720fe611-faa0-4b7f-b5a0-ec32e6b43006",
    "name": "Silver Partner",
    "referenceValue": 750000,
    "benefits": [
      "A distinctive recognition plaque for the partnership category, presented at the forum's opening ceremony.",
      "Participation in paid digital campaigns on social media platforms.",
      "Twenty invitations for the partner's leadership to attend the opening ceremony.",
      "One VVIP seat for the partner's representative to attend the forum at the main stage.",
      "Prominent placement of the partner's name and logo on all forum promotional print materials, press announcements, invitation cards and marketing brochures.",
      "A small booth within the Digital Saudi Exhibition.",
      "Allocated time on the Digital Saudi stage to showcase the partner's digital transformation initiatives.",
      "Placement of the partner's name and logo in commercial advertisements and indoor and outdoor banners, including the attendee-area backdrop."
    ]
  },
  {
    "id": "720fe611-faa0-4b7f-b5a0-ec32e6b43007",
    "name": "Exhibition Booth",
    "referenceValue": 500000,
    "benefits": [
      "A recognition plaque for the partnership category, presented on the Digital Saudi stage.",
      "A medium-sized booth within the exhibition."
    ]
  }
]
$catalog$::jsonb) as entry
)
insert into public.maestro_packages (id, data)
select catalog.id, catalog.data
from catalog
where not exists (
  select 1 from public.maestro_packages existing
  where existing.id = catalog.id
     or lower(btrim(existing.data->>'name')) = lower(btrim(catalog.data->>'name'))
);
