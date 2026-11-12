variable "state_passphrase" {
  description = "Passphrase for the encrypted state (TF_VAR_state_passphrase)."
  type        = string
  sensitive   = true
}

variable "image_path" {
  description = "The NixOS qcow2 built from deploy/nixos (tofu.sh sets it). Used only when the VM is first created."
  type        = string
}

variable "node" {
  description = "Proxmox node name."
  type        = string
  default     = "pve"
}

variable "vm_id" {
  description = "VM ID on the Proxmox host."
  type        = number
  default     = 104
}

variable "cloudflare_zone_id" {
  description = "Cloudflare zone id of the domain the public names are in (site.env)."
  type        = string
}

variable "lan_ipv4" {
  description = "The VM's LAN address the public names point at (DNS only, LAN-reachable) (site.env)."
  type        = string
}

variable "dns_names" {
  description = "The public names of the app and Keycloak, e.g. [\"learnharness.example.com\", \"auth.example.com\"] (site.env)."
  type        = list(string)
}
