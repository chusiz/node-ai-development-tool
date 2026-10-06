extends CharacterBody2D

@export var move_speed: float = 400.0
@onready var screen_size = get_viewport_rect().size

func _physics_process(delta: float) -> void:
	var input_dir: float = Input.get_axis("ui_left", "ui_right")
	velocity.x = input_dir * move_speed
	
	move_and_slide()
	
	# 限制玩家不出屏幕左右边界
	position.x = clamp(position.x, 0 + (rect_size.x / 2), screen_size.x - (rect_size.x / 2))
