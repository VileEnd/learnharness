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
  description = "Cloudflare zone of moyjak.com."
  type        = string
  default     = "d58d4cd5f04aa75599f11795072ff40f"
}

variable "lan_ipv4" {
  description = "The VM's LAN address the public names point at (DNS only, LAN-reachable). 10.20.1.70 after the UniFi move day."
  type        = string
  default     = "192.168.178.175"
}
