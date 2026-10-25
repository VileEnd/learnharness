# Public names for the LAN-only stack. The records point at a private
# address, so they resolve everywhere but only work inside the home
# network; they exist so Let's Encrypt (DNS challenge) can issue certificates
# every device trusts. Not proxied — Cloudflare never sees the traffic.
resource "cloudflare_dns_record" "learnharness" {
  for_each = toset(["learnharness.home.moyjak.com", "auth.home.moyjak.com"])

  zone_id = var.cloudflare_zone_id
  name    = each.value
  type    = "A"
  content = var.lan_ipv4
  ttl     = 300
  proxied = false
  comment = "LearnHarness (LAN only), managed by OpenTofu: VileEnd/learnharness deploy/proxmox"
}
