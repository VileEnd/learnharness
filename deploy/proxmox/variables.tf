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
